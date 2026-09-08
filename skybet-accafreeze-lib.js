// skybet-accafreeze-lib.js — real scraper logic, required directly by server.js on the DO box
// (NOT deployed as a Netlify function itself — netlify/functions/skybet-accafreeze.js is a thin
// proxy to it, same split as oc-ev.js/fixtures.js). Moved here 2026-09-07 after discovering
// SkyBet blocks the request outright when it comes from Netlify's US-based function IP (an
// "Unavailable Page" response, not a Cloudflare bot-challenge — almost certainly SkyBet's
// UK/Ireland gambling-license geo-fence, confirmed by cf-ray showing an IAD/Virginia PoP). The
// DO droplet this now runs from is itself London-based (confirmed via ipinfo.io), which a UK
// gambling site's geo-fence should accept where a US Lambda never will.
//
// 2026-09-08: the bare apex host `https://skybet.com/...` started returning HTTP 406 (Cloudflare
// in front of a Tomcat "Application Server - Error report" page) for every path — SkyBet seems
// to have broken/removed the apex→www redirect. `https://www.skybet.com/...` (and m.skybet.com)
// still serve the full SSR page fine, so all the page fetches / Referer / Origin below use www.
// The apitbd.skybet.com GraphQL host is unaffected.
//
// Scrapes SkyBet's Acca Freeze eligible-fixtures list (team names, kickoff, Full Time Result
// odds, isAccaFreezeEligible flag) for the acca-freeze-builder project.
//
// Mechanism (reverse-engineered 2026-09-07 from a live authenticated session's dev tools —
// SkyBet has no public API for this):
//   1. GET the football hub page and pull the "AccaFreeze" link out of it — the coupon id in
//      that link (cpn-XXXX) is a rotating content-system id, NOT stable long-term, so it's
//      re-discovered every run rather than hardcoded.
//   2. GET that coupon page. It server-renders EVERYTHING inline (no headless browser needed)
//      as window.__TBD_PRELOADED_CATALOG__ and window.__PRELOADED_STATE__ — extract both with
//      a balanced-brace scan (same technique as oc-scraper's logic_markets.extractBookmakerNames
//      for Oddschecker, since a plain regex can't safely bound a JSON blob with nested braces).
//   3. __TBD_PRELOADED_CATALOG__.data.FilteredCouponCardGroup[0].items is the FULL ordered list
//      of card URNs for the coupon (CouponHeaderCard + EventMarketCard interleaved) — only the
//      first handful arrive with full detail already resolved inline; the rest need step 4.
//   4. POST the same "Card" persisted GraphQL query (documentId below — SkyBet's client sends
//      only this hash, never the literal query text) in batches of urns to apitbd.skybet.com to
//      resolve full EventMarketCard detail (team names, odds, isAccaFreezeEligible) for the rest.
//
// Auth: SKYBET_COOKIES env var — a full browser Cookie header string from a logged-in session
// (same pattern as BB_HASH/BB_COOKIES for BookieBashing in bb-odds.js). Lives in the DO box's
// ecosystem.config.js now (untracked, same as LEDGER_API_KEY — see do-server-deploy-drift notes),
// NOT Netlify's env vars, since this file only ever runs there. Expires periodically and needs
// manually refreshing — grab a fresh one from dev tools (Network tab, any apitbd.skybet.com
// request's Cookie request header) when this starts erroring, then `pm2 restart --update-env`.
//
// Coupon discovery: SKYBET_ACCAFREEZE_PATH env var — e.g.
// "odds/accafreeze/cpn-ZvPjBBIAACMANFoX%2Fcv%2Fhome?d=ZyJefREAAB4AstY9". Tried auto-discovering
// this from the football hub page and a couple of generic guessed URLs (2026-09-07) — none of
// them reliably surfaced it (one apparent hit came from a WebFetch summary paraphrasing content
// that wasn't actually in the raw page, not a real link). Treated as a second manually-refreshed
// value alongside the cookie rather than something worth over-engineering discovery for: open
// the Acca Freeze page in a logged-in browser, copy the "odds/accafreeze/cpn-..." path (with its
// "?d=..." query string) out of the address bar, and set it here when this starts erroring.
//
// Fragile-by-nature bits, flagged so a future failure is fast to diagnose rather than a mystery:
//   - CARD_DOCUMENT_ID is a persisted-query hash tied to SkyBet's current frontend build. If
//     SkyBet redeploys and changes the query, every batch request will start failing — the fix
//     is to recapture a fresh one the same way this was found (dev tools -> Network -> filter
//     "bff-gql" -> a `query=Card` request's Payload tab).
//   - QUERY_CONTEXT below (preferences/experiments/productExclusions) is a snapshot of one
//     account's actual bucketing, sent verbatim on every batch rather than re-derived per run —
//     simplification that should be harmless (it looks like UI-variant plumbing, not a data
//     filter) but hasn't been proven never to matter.
const CARD_DOCUMENT_ID = 'Card#ed393a254c0cebbd3469dc600ea16864';
const QUERY_CONTEXT = {
  preferences: { userProducts: ['SPORTSBOOK', 'GAMES'], favoriteSports: [] },
  productExclusions: [],
  experiments: [
    { id: 'exp-sbg-tennis-bab-button', variant: 'exp-bab-button-featuread-matches-tennis' },
    { id: 'exp-pop-bet-builder-stake-returns', variant: 'exp-pop-bet-builder-stake-returns-on' },
    { id: 'exp-stats-lineups-player-bottom-sheet', variant: 'exp-stats-lineups-player-bottom-sheet' },
    { id: 'football_team_form_in_header', variant: 'control' },
    { id: 'ascending-selection-price-ordering-on-inplay-pcbs', variant: 'ascending-selection-price-ordering-on-inplay-pcbs-on' },
    { id: 'exp-sbg-squad-bet-onboarding-vs-popular-new', variant: 'sbg-squad-bet-popular-new' },
    { id: 'exp-search-filter', variant: 'control' },
  ],
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FREEZE_TARGET_MIN_ODDS = 7.0;
// Confirmed live 2026-09-07: the server silently returns {data:{Cards:null}} (200 OK, no error)
// for any batch of 11+ urns — no error to catch, it just goes quiet. 10 is the real limit; the
// live client itself only ever sends ~8 at a time, so this isn't a made-up safety margin.
const BATCH_SIZE = 10;

// Same balanced-brace scan oc-scraper's logic_markets.py uses for Oddschecker's embedded JSON —
// a plain regex can't safely find where a JSON object with its own nested {} actually ends.
function extractBalancedObject(text, openBracePos) {
  let depth = 0, inString = false, escape = false;
  for (let i = openBracePos; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(openBracePos, i + 1); }
  }
  return null;
}

function extractWindowVar(html, varName) {
  const marker = `window.${varName} = `;
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const block = extractBalancedObject(html, idx + marker.length);
  if (!block) return null;
  try { return JSON.parse(block); } catch (e) { return null; }
}

async function skybetFetch(url, cookies, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      'User-Agent': UA,
      'Accept': options.body ? 'application/json' : 'text/html',
      'Cookie': cookies,
      'Referer': 'https://www.skybet.com/',
      'Origin': 'https://www.skybet.com',
      ...(options.headers || {})
    }
  });
}

// Step 1: get today's AccaFreeze coupon path. SKYBET_ACCAFREEZE_PATH (manually refreshed, same
// as the cookie) is the primary source — see the module comment above for why auto-discovery
// isn't trusted as the main path. Falls back to a best-effort scan of the football hub page's
// own preloaded catalog only if that env var is unset, on the chance it happens to work.
async function findAccaFreezeCouponUrl(cookies) {
  if (process.env.SKYBET_ACCAFREEZE_PATH) return process.env.SKYBET_ACCAFREEZE_PATH;

  const res = await skybetFetch('https://www.skybet.com/football/s-1', cookies);
  if (!res.ok) throw new Error(`football hub HTTP ${res.status}`);
  const html = await res.text();

  const catalog = extractWindowVar(html, '__TBD_PRELOADED_CATALOG__');
  if (catalog && catalog.data) {
    for (const c of catalog.data.GenericSwitcherCard || []) {
      const link = c.selectedViewLink;
      if (link && link.label === 'AccaFreeze' && link.viewLink) return link.viewLink.viewUrl;
    }
  }
  const m = html.match(/href="([^"]*odds\/accafreeze\/cpn-[^"]*)"/);
  if (m) return m[1].replace(/&amp;/g, '&');

  throw new Error('SKYBET_ACCAFREEZE_PATH not set, and auto-discovery from the football hub page found nothing — see module comment');
}

// Step 2/3: load the coupon page itself, pull out the full card list + session context needed
// for step 4's batched GraphQL calls.
async function loadCouponPage(couponPath, cookies) {
  const res = await skybetFetch(`https://www.skybet.com/${couponPath}`, cookies);
  if (!res.ok) {
    // Extra diagnostics on failure — cf-mitigated/server tell us whether this is Cloudflare
    // bot-management blocking the request outright (vs. e.g. a plain expired-session redirect),
    // and a body snippet shows a challenge page ("Just a moment...") vs a normal error page.
    const cfMitigated = res.headers.get('cf-mitigated');
    const cfRay = res.headers.get('cf-ray');
    const server = res.headers.get('server');
    const bodySnippet = (await res.text().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ').trim();
    throw new Error(`coupon page HTTP ${res.status} | server=${server} cf-ray=${cfRay} cf-mitigated=${cfMitigated} | body: ${bodySnippet}`);
  }
  const html = await res.text();
  const catalog = extractWindowVar(html, '__TBD_PRELOADED_CATALOG__');
  const preloaded = extractWindowVar(html, '__PRELOADED_STATE__');
  if (!catalog || !preloaded) throw new Error('could not find preloaded state in coupon page — SkyBet may have changed its page structure');

  const group = (catalog.data.FilteredCouponCardGroup || [])[0];
  if (!group) throw new Error('no FilteredCouponCardGroup in preloaded catalog');
  const urns = group.items.map(i => i.urn);
  const appKey = preloaded.entities.appkey;
  const currentViewUrn = preloaded.router.currentUrn;

  // Already-resolved cards from the initial page load — no need to re-fetch these.
  const initialCards = [
    ...(catalog.data.EventMarketCard || []),
    ...(catalog.data.CouponHeaderCard || []),
  ];
  return { urns, appKey, currentViewUrn, initialCards };
}

// Step 4: resolve every remaining urn's full card detail via the "Card" persisted query.
async function resolveCards(urns, appKey, currentViewUrn, cookies) {
  const url = `https://apitbd.skybet.com/api/tbd/bff-gql/v11/?_ak=${encodeURIComponent(appKey)}&currentViewUrn=${encodeURIComponent(currentViewUrn)}`;
  const out = [];
  for (let i = 0; i < urns.length; i += BATCH_SIZE) {
    const batch = urns.slice(i, i + BATCH_SIZE);
    const body = JSON.stringify({
      variables: { urn: batch, numberOfFilledCardsInCardGroup: 2, ...QUERY_CONTEXT },
      documentId: CARD_DOCUMENT_ID,
    });
    const res = await skybetFetch(url, cookies, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) throw new Error(`Card query HTTP ${res.status} (batch starting at ${i})`);
    const json = await res.json();
    if (!json.data || !Array.isArray(json.data.Cards)) throw new Error(`unexpected Card query shape (batch starting at ${i})`);
    out.push(...json.data.Cards);
  }
  return out;
}

// Flatten one resolved EventMarketCard down to what the acca-freeze builder actually needs.
function toFixture(card) {
  if (!card || card.__typename !== 'EventMarketCard') return null;
  const fx = card.fixture;
  const mkt = card.displayRunners && card.displayRunners.sportsbook && card.displayRunners.sportsbook.market;
  if (!fx || !mkt) return null;
  const liveRunners = (mkt.liveData && mkt.liveData.runners) || [];
  const oddsByResult = {};
  for (const r of mkt.runners || []) {
    const live = liveRunners.find(x => x.selectionId === r.selectionId);
    if (live) oddsByResult[r.resultType] = live.odds.decimal;
  }
  return {
    eventId: card.sportevent && card.sportevent.eventId,
    home: fx.home.name,
    away: fx.away.name,
    kickoff: fx.scheduledAt,
    competition: card.sportevent && card.sportevent.competition && card.sportevent.competition.name,
    homeOdds: oddsByResult.HOME ?? null,
    drawOdds: oddsByResult.DRAW ?? null,
    awayOdds: oddsByResult.AWAY ?? null,
    accaFreezeEligible: !!mkt.isAccaFreezeEligible,
    url: card.eventViewLink && card.eventViewLink.viewUrl,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const cookies = process.env.SKYBET_COOKIES;
  if (!cookies) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'SKYBET_COOKIES not set' }) };

  try {
    const couponPath = await findAccaFreezeCouponUrl(cookies);
    const { urns, appKey, currentViewUrn, initialCards } = await loadCouponPage(couponPath, cookies);
    const initialUrns = new Set(initialCards.map(c => c.urn));
    const remaining = urns.filter(u => !initialUrns.has(u));
    const resolved = remaining.length ? await resolveCards(remaining, appKey, currentViewUrn, cookies) : [];

    const fixtures = [...initialCards, ...resolved].map(toFixture).filter(Boolean);
    const freezeTargets = fixtures.filter(f =>
      f.accaFreezeEligible && ((f.homeOdds != null && f.homeOdds >= FREEZE_TARGET_MIN_ODDS) || (f.awayOdds != null && f.awayOdds >= FREEZE_TARGET_MIN_ODDS))
    );

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: true, updated: new Date().toISOString(), count: fixtures.length, fixtures, freezeTargets }),
    };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

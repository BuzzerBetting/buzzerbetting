// skybet-bfex-lib.js — every football fixture Betfair Exchange has a MATCH_ODDS market for in
// the next 5 days, with lay prices + liquidity, plus SkyBet back (Full Time Result) odds.
// Backend only — feeds the acca-freeze builder; not rendered anywhere yet.
//
// Runs on the DO box (required directly by server.js), NOT a Netlify function: Betfair needs
// the cert-login (client-2048.crt/.key on /root) and SkyBet is geo-fenced.
//
// SkyBet has no scrapeable all-football list (fixture-list routes 404; the data is behind a
// bff-gql GraphQL layer, and the browser tool blocks gambling sites so it can't be captured
// live). BUT the acca-freeze acca only needs the ONE high-odds "freeze target" leg to be Acca
// Freeze eligible — the other 4 fodder legs can be any match — so we need SkyBet back odds for
// ALL fixtures, not just the acca-freeze coupon. Mechanism:
//   - Betfair listMarketCatalogue(MATCH_ODDS, now..now+5d) is the fixture universe (~500).
//   - SkyBet odds come from the accafreeze feed (skybet-accafreeze-lib) where the fixture is on
//     that coupon (free, ~170), else resolved per-fixture: SkyBet SearchView#<hash> {query:team}
//     → EventView url → GET that event page → parse the server-rendered SportsbookMarket
//     (MATCH_ODDS) + SportsbookRunnerLiveData decimal odds + isAccaFreezeEligible.
//   - Per-fixture resolutions are disk-cached (data/sky_odds_cache.json, ~25min TTL) and capped
//     per call, so a cron hitting this repeatedly keeps the cache warm and calls stay quick.
//
// Betfair login / bfCall are copied from netlify/functions/betfair.js (kept in sync by hand).

const https = require('https');
const fs = require('fs');
const path = require('path');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const BFEX_BASE = 'https://api.betfair.com/exchange/betting/rest/v1.0';
const DRAW_SELECTION_ID = 58805; // Betfair's (and SkyBet's) fixed "Draw" selectionId in football
const WINDOW_DAYS = 5;
const BOOK_CHUNK = 40;

const SKY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SKY_GQL = 'https://apitbd.skybet.com/api/tbd/bff-gql/v11/';
const SKY_APPKEY = 'DuJYiLaRflSsueCd'; // from the football hub's __PRELOADED_STATE__.entities.appkey
const SKY_SEARCH_DOC = 'SearchView#185684815f1216bfd5f46eda8d2dbb4c';
const SKY_CARD_DOC = 'Card#ed393a254c0cebbd3469dc600ea16864';
const SKY_MARKETS_DOC = 'Markets#ede59ffff6ffb3ed784ee6e393a81881';
const SKY_QC = { preferences: { userProducts: ['SPORTSBOOK', 'GAMES'], favoriteSports: [] }, productExclusions: [], experiments: [] };
const SKY_CACHE_PATH = path.join(__dirname, 'data', 'sky_odds_cache.json');
const SKY_TTL_MS = 25 * 60 * 1000;       // re-resolve a hit after this
const SKY_NEG_TTL_MS = 45 * 60 * 1000;   // re-try a miss after this
const MAX_SKY_RESOLVE = 150;             // live resolutions per call unless ?full=1
const SKY_CONCURRENCY = 4;

// ── Betfair plumbing (copied from netlify/functions/betfair.js) ───────────────
const CERT = fs.readFileSync('/root/client-2048.crt');
const KEY = fs.readFileSync('/root/client-2048.key');

function directFetch(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const reqOptions = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      ...(options.cert ? { cert: options.cert, key: options.key } : {}),
    };
    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, text: () => Promise.resolve(data) }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function getSessionToken() {
  const username = process.env.BFEX_USERNAME;
  const password = process.env.BFEX_PASSWORD;
  const appKey = process.env.BFEX_APP_KEY;
  if (!username || !password) throw new Error('BFEX_USERNAME or BFEX_PASSWORD not set');
  const body = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  const res = await directFetch('https://identitysso-cert.betfair.com/api/certlogin', {
    method: 'POST', cert: CERT, key: KEY,
    headers: {
      'X-Application': appKey,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch (e) { throw new Error('Login returned non-JSON: ' + text.substring(0, 200)); }
  if (data.loginStatus !== 'SUCCESS') throw new Error(`Login failed: ${data.loginStatus}`);
  return data.sessionToken;
}

async function bfCall(method, params, appKey, session) {
  const res = await directFetch(`${BFEX_BASE}/${method}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Application': appKey,
      'X-Authentication': session,
      'Accept': 'application/json',
    },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  if (text.trim().startsWith('<')) throw new Error('SESSION_EXPIRED');
  const data = JSON.parse(text);
  if (data.faultcode) throw new Error(data.faultstring || JSON.stringify(data));
  return data;
}

// ── shared helpers ──────────────────────────────────────────────────────────
function norm(n) {
  return (n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\butd\b/g, 'united').replace(/\bnottm\b/g, 'nottingham')
    .replace(/\bwolves\b/g, 'wolverhampton').replace(/\bspurs\b/g, 'tottenham')
    .replace(/\bmunich\b/g, 'munchen')
    .replace(/\b(fc|afc|cf|sc|ss|as|ac|sv|bk|if|fk|club|w|res)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function teamEq(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = na.split(' ').filter(w => w.length > 2), wb = nb.split(' ').filter(w => w.length > 2);
  if (!wa.length || !wb.length) return false;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (short.length === 1) return short[0] === long[0];
  return short.every(w => long.join(' ').includes(w)) || long.every(w => short.join(' ').includes(w));
}
// balanced-brace scan for a `window.<var> = {...}` blob in server-rendered HTML
function extractWindowVar(html, varName) {
  const marker = `window.${varName} = `;
  const start = html.indexOf(marker);
  if (start === -1) return null;
  let i = start + marker.length, depth = 0, inStr = false, esc = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(start + marker.length, i + 1)); } catch (e) { return null; } } }
  }
  return null;
}
async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = null; }
    }
  }));
  return out;
}

// ── Betfair: every football MATCH_ODDS market in the window, with lay prices ──
async function fetchBfexMatchOdds(appKey, session) {
  const from = new Date().toISOString();
  const to = new Date(Date.now() + WINDOW_DAYS * 864e5).toISOString();

  const cat = await bfCall('listMarketCatalogue', {
    filter: { eventTypeIds: ['1'], marketTypeCodes: ['MATCH_ODDS'], marketStartTime: { from, to } },
    marketProjection: ['EVENT', 'COMPETITION', 'MARKET_START_TIME', 'RUNNER_DESCRIPTION'],
    maxResults: 1000, // Betfair's cap; 5-day football is ~500-700, comfortably under
    sort: 'FIRST_TO_START',
  }, appKey, session);
  if (!Array.isArray(cat)) throw new Error('listMarketCatalogue: unexpected shape');

  const byMarket = {};
  for (const m of cat) {
    byMarket[m.marketId] = {
      marketId: m.marketId,
      eventId: m.event && m.event.id,
      eventName: m.event && m.event.name || '',
      competition: m.competition && m.competition.name || '',
      startTime: m.marketStartTime || (m.event && m.event.openDate) || null,
      runners: (m.runners || []).map(r => ({ selectionId: r.selectionId, name: r.runnerName, sortPriority: r.sortPriority })),
    };
  }

  const ids = Object.keys(byMarket);
  for (let i = 0; i < ids.length; i += BOOK_CHUNK) {
    const chunk = ids.slice(i, i + BOOK_CHUNK);
    const books = await bfCall('listMarketBook', {
      marketIds: chunk,
      priceProjection: { priceData: ['EX_BEST_OFFERS'], virtualise: true },
    }, appKey, session);
    for (const b of (books || [])) {
      const m = byMarket[b.marketId];
      if (!m) continue;
      m.status = b.status;
      m.totalMatched = b.totalMatched ?? null;
      m.book = {};
      for (const r of (b.runners || [])) {
        const bestLay = (r.ex && r.ex.availableToLay || [])[0] || null;
        m.book[r.selectionId] = {
          lay: bestLay ? bestLay.price : null,
          laySize: bestLay ? bestLay.size : null,
          matched: r.totalMatched ?? null,
          status: r.status,
        };
      }
    }
  }

  return Object.values(byMarket).map(m => {
    const parts = m.eventName.split(/\s+v\s+/i);
    const evHome = parts[0], evAway = parts[1];
    let homeR = null, awayR = null, drawR = null;
    for (const r of m.runners) {
      if (r.selectionId === DRAW_SELECTION_ID || /^the draw$/i.test(r.name)) { drawR = r; continue; }
      if (evHome && teamEq(r.name, evHome)) homeR = r;
      else if (evAway && teamEq(r.name, evAway)) awayR = r;
    }
    if (!homeR || !awayR) {
      const nonDraw = m.runners.filter(r => r !== drawR).sort((a, b) => (a.sortPriority || 9) - (b.sortPriority || 9));
      homeR = homeR || nonDraw[0];
      awayR = awayR || nonDraw[1];
    }
    const px = r => (r && m.book && m.book[r.selectionId]) || { lay: null, laySize: null, matched: null };
    return {
      marketId: m.marketId,
      eventId: m.eventId,
      eventName: m.eventName,
      home: evHome || (homeR && homeR.name) || '',
      away: evAway || (awayR && awayR.name) || '',
      competition: m.competition,
      startTime: m.startTime,
      status: m.status || null,
      totalMatched: m.totalMatched,
      lay: {
        home: px(homeR).lay, homeSize: px(homeR).laySize, homeMatched: px(homeR).matched,
        draw: px(drawR).lay, drawSize: px(drawR).laySize, drawMatched: px(drawR).matched,
        away: px(awayR).lay, awaySize: px(awayR).laySize, awayMatched: px(awayR).matched,
      },
    };
  });
}

// ── SkyBet: per-fixture Full Time Result odds (search → event page) ──────────
function skyHeaders(json) {
  const h = {
    'User-Agent': SKY_UA,
    'Accept': json ? 'application/json' : 'text/html',
    'Cookie': process.env.SKYBET_COOKIES || '',
    'Referer': 'https://skybet.com/football/s-1',
    'Origin': 'https://skybet.com',
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}
async function skySearch(query) {
  const res = await fetch(SKY_GQL + '?_ak=' + encodeURIComponent(SKY_APPKEY), {
    method: 'POST', headers: skyHeaders(true),
    body: JSON.stringify({ documentId: SKY_SEARCH_DOC, variables: { query } }),
  });
  const j = await res.json().catch(() => null);
  const results = j && j.data && j.data.Search && j.data.Search.results || [];
  return results.filter(r => r && r.__typename === 'EventView' && r.url).map(r => ({
    url: r.url,
    name: (r.sportevent && r.sportevent.name) || '',
    eventId: (String(r.url).match(/e-(\d+)/) || [])[1] || null,
  }));
}
// Fast path: many SkyBet event pages inline the market as window.__TBD_PRELOADED_CATALOG__
function parseEventPageOdds(html) {
  const cat = extractWindowVar(html, '__TBD_PRELOADED_CATALOG__');
  const d = (cat && cat.data) || {};
  const mkts = d.SportsbookMarket || [];
  const live = d.SportsbookRunnerLiveData || [];
  const mo = mkts.find(m => m && m.marketType === 'MATCH_ODDS');
  if (!mo || !mo.runners) return null;
  const oddsBySel = {};
  for (const r of live) oddsBySel[r.selectionId] = r.odds && r.odds.decimal;
  const byResult = {};
  for (const r of mo.runners) byResult[r.resultType] = oddsBySel[r.selectionId] ?? null;
  if (byResult.HOME == null && byResult.AWAY == null) return null;
  return {
    odds: { home: byResult.HOME ?? null, draw: byResult.DRAW ?? null, away: byResult.AWAY ?? null },
    eligible: !!mo.isAccaFreezeEligible,
    marketId: mo.marketId || null,
  };
}
// depth-first search of a parsed object for the first node matching pred
function deepFind(node, pred, depth) {
  if (node == null || depth > 30) return null;
  if (typeof node === 'object') {
    if (pred(node)) return node;
    for (const k of Object.keys(node)) {
      const hit = deepFind(node[k], pred, (depth || 0) + 1);
      if (hit) return hit;
    }
  }
  return null;
}
async function skyGql(documentId, variables, currentViewUrn) {
  const url = SKY_GQL + '?_ak=' + encodeURIComponent(SKY_APPKEY) +
    (currentViewUrn ? '&currentViewUrn=' + encodeURIComponent(currentViewUrn) : '');
  const res = await fetch(url, { method: 'POST', headers: skyHeaders(true), body: JSON.stringify({ documentId, variables }) });
  return res.json().catch(() => null);
}
// Fallback for "thin" SSR event pages: nav-tabs Card# → the MATCH_ODDS sbkMarket urn →
// Markets# for its live odds. `html` is the already-fetched (thin) event page.
async function resolveViaGraphQL(html, eventId) {
  const navUrn = (html.match(/ppb:tbd:card:navigationTabsList:[A-Za-z0-9]+\/e\/\d+/) || [])[0];
  if (!navUrn) return null;
  const viewUrn = 'ppb:tbd:view:event:' + eventId;
  const nav = await skyGql(SKY_CARD_DOC, { urn: [navUrn], numberOfFilledCardsInCardGroup: 2, ...SKY_QC }, viewUrn);
  const mo = deepFind(nav, n => n.__typename === 'SportsbookMarket' && n.marketType === 'MATCH_ODDS', 0);
  if (!mo || !mo.urn || !Array.isArray(mo.runners)) return null;
  const mk = await skyGql(SKY_MARKETS_DOC, { URNs: [mo.urn], productExclusions: [], preferences: SKY_QC.preferences }, viewUrn);
  const market = mk && mk.data && mk.data.Markets && mk.data.Markets[0];
  const runners = market && market.liveData && market.liveData.runners || [];
  const oddsBySel = {};
  for (const r of runners) oddsBySel[r.selectionId] = (r.odds && r.odds.decimal) ?? (r.displayOdds && r.displayOdds.decimal);
  const byResult = {};
  for (const r of mo.runners) byResult[r.resultType] = oddsBySel[r.selectionId] ?? null;
  if (byResult.HOME == null && byResult.AWAY == null) return null;
  return {
    odds: { home: byResult.HOME ?? null, draw: byResult.DRAW ?? null, away: byResult.AWAY ?? null },
    eligible: !!mo.isAccaFreezeEligible,
    marketId: mo.marketId || (mo.urn.split(':').pop()) || null,
  };
}
function skyCacheKey(home, away, kickoff) {
  return `${norm(home)}|${norm(away)}|${(kickoff || '').slice(0, 10)}`;
}
function loadSkyCache() {
  try { return JSON.parse(fs.readFileSync(SKY_CACHE_PATH, 'utf8')); } catch (e) { return {}; }
}
function saveSkyCache(cache) {
  try {
    fs.mkdirSync(path.dirname(SKY_CACHE_PATH), { recursive: true });
    fs.writeFileSync(SKY_CACHE_PATH, JSON.stringify(cache));
  } catch (e) { /* non-fatal */ }
}
// resolve one Betfair fixture's SkyBet FTR odds. Returns {odds,eligible,url,eventId,source} | null
async function resolveSkyOdds(fx, cache) {
  const key = skyCacheKey(fx.home, fx.away, fx.startTime);
  const hit = cache[key];
  const now = Date.now();
  if (hit) {
    const age = now - (hit.ts || 0);
    if (hit.odds && age < SKY_TTL_MS) return { ...hit, source: 'search-cache' };
    if (!hit.odds && age < SKY_NEG_TTL_MS) return null; // cached miss, still fresh
  }
  let found = null;
  for (const q of [fx.home, fx.away]) {
    let hits;
    try { hits = await skySearch(q); } catch (e) { hits = []; }
    found = hits.find(h => {
      const parts = String(h.url).split('/');
      const slugPair = parts[parts.length - 2] || h.name; // "home-v-away"
      const nm = slugPair.replace(/-/g, ' ');
      const [hn, an] = nm.split(/ v /i);
      return (teamEq(fx.home, hn) && teamEq(fx.away, an)) ||
             (teamEq(fx.home, h.name.split(/ v /i)[0]) && teamEq(fx.away, h.name.split(/ v /i)[1]));
    });
    if (found) break;
  }
  if (!found) { cache[key] = { ts: now, odds: null }; return null; }

  let odds = null;
  try {
    const res = await fetch('https://skybet.com/' + found.url, { headers: skyHeaders(false) });
    if (res.ok) {
      const html = await res.text();
      odds = parseEventPageOdds(html);                                   // fast path (inline market)
      if (!odds) odds = await resolveViaGraphQL(html, found.eventId);    // thin-page fallback
    }
  } catch (e) { /* leave null */ }

  if (!odds) { cache[key] = { ts: now, odds: null }; return null; }
  const entry = { ts: now, odds: odds.odds, eligible: odds.eligible, url: found.url, eventId: found.eventId, marketId: odds.marketId };
  cache[key] = entry;
  return { ...entry, source: 'search' };
}

// ── Join: SkyBet fixture (from accafreeze feed) for a Betfair event ─────────
function findSky(bfexFx, skyList) {
  const bt = bfexFx.startTime ? Date.parse(bfexFx.startTime) : null;
  let best = null, bestDelta = Infinity;
  for (const s of skyList) {
    if (!(teamEq(bfexFx.home, s.home) && teamEq(bfexFx.away, s.away))) continue;
    const st = s.kickoff ? Date.parse(s.kickoff) : null;
    const delta = (bt && st) ? Math.abs(bt - st) : 0;
    if (delta < bestDelta) { best = s; bestDelta = delta; }
  }
  if (best && bt && best.kickoff && bestDelta > 6 * 3600e3) return null;
  return best;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const appKey = process.env.BFEX_APP_KEY;
  if (!appKey) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'BFEX_APP_KEY not set' }) };
  const full = ((event.queryStringParameters || {}).full === '1');

  try {
    // 1. Betfair MATCH_ODDS for the next 5 days — the fixture spine
    const session = await getSessionToken();
    const bfexList = await fetchBfexMatchOdds(appKey, session);

    // 2. accafreeze feed → free SkyBet odds for the coupon fixtures
    let skyList = [];
    try {
      const r = await require('./skybet-accafreeze-lib').handler({ httpMethod: 'GET', queryStringParameters: {} });
      const j = JSON.parse(r.body);
      if (j.ok) skyList = j.fixtures || [];
    } catch (e) { /* leave empty */ }

    // 3. Attach accafreeze odds; collect the rest for per-fixture SkyBet resolution
    const cache = loadSkyCache();
    const rows = bfexList.map(b => {
      const s = findSky(b, skyList);
      return {
        b,
        sky: s ? {
          eventId: s.eventId, url: s.url || null,
          odds: { home: s.homeOdds ?? null, draw: s.drawOdds ?? null, away: s.awayOdds ?? null },
          accaFreezeEligible: !!s.accaFreezeEligible, source: 'accafreeze',
        } : null,
      };
    });

    // Cache-only pass first (free): apply every fresh cached hit, note fresh misses, and
    // collect only the genuinely-uncached fixtures for a live lookup (that's what the cap limits).
    const now = Date.now();
    let fromCache = 0;
    const needLive = [];
    for (const r of rows) {
      if (r.sky) continue;
      const hit = cache[skyCacheKey(r.b.home, r.b.away, r.b.startTime)];
      const age = hit ? now - (hit.ts || 0) : Infinity;
      if (hit && hit.odds && age < SKY_TTL_MS) {
        r.sky = { eventId: hit.eventId, url: hit.url || null, odds: hit.odds, accaFreezeEligible: !!hit.eligible, source: 'search-cache' };
        fromCache++;
      } else if (hit && !hit.odds && age < SKY_NEG_TTL_MS) {
        // fresh cached miss — don't re-hit SkyBet yet
      } else {
        needLive.push(r);
      }
    }
    // prefer fixtures with a favourite (likely fodder legs) when capping
    needLive.sort((x, y) => favPrice(x.b) - favPrice(y.b));
    const slice = full ? needLive : needLive.slice(0, MAX_SKY_RESOLVE);
    const resolved = await mapPool(slice, SKY_CONCURRENCY, r => resolveSkyOdds(r.b, cache));
    slice.forEach((r, i) => {
      const o = resolved[i];
      if (o && o.odds) r.sky = { eventId: o.eventId, url: o.url || null, odds: o.odds, accaFreezeEligible: !!o.eligible, source: o.source };
    });
    saveSkyCache(cache);

    const fixtures = rows.map(({ b, sky }) => ({
      eventName: b.eventName,
      home: b.home,
      away: b.away,
      kickoff: b.startTime,
      competition: b.competition,
      bfex: { marketId: b.marketId, eventId: b.eventId, status: b.status, totalMatched: b.totalMatched, lay: b.lay },
      sky,
    })).sort((a, c) => (a.kickoff || '').localeCompare(c.kickoff || ''));

    const withSky = fixtures.filter(f => f.sky).length;
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: true,
        updated: new Date().toISOString(),
        windowDays: WINDOW_DAYS,
        count: fixtures.length,
        withSkyOdds: withSky,
        skyFromCache: fromCache,
        skyResolvedThisCall: slice.length,
        skyStillMissing: fixtures.length - withSky,
        fixtures,
      }),
    };
  } catch (err) {
    const expired = err.message === 'SESSION_EXPIRED';
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message, sessionExpired: expired }) };
  }
};

function favPrice(b) {
  const h = b.lay && b.lay.home, a = b.lay && b.lay.away;
  return Math.min(h || 999, a || 999);
}

// oddsmonkey-lib.js — SkyBet Full-Time-Result back odds via OddsMonkey's OddsMatcher.
//
// 2026-09-09: SkyBet hard-blocked all of skybet-bfex-lib.js's direct scraping (see
// skybet-throttle.js) for 24h+, surviving a fresh cf_clearance cookie AND a residential
// proxy IP — so it's not a simple IP/cookie ban, and there's no fix on that side right now.
// OddsMonkey's OddsMatcher tool (a matched-betting odds comparator the user already
// subscribes to) surfaces the same SkyBet back odds it shows in-browser via a GraphQL API
// at api.oddsplatform.profitaccumulator.com — and that endpoint takes NO auth at all
// (no cookie, no bearer token; confirmed by capturing the tool's own DevTools request,
// which carries neither). It's presumably gated only by browser-enforced CORS
// (`origin: https://oddsmatcher.oddsmonkey.com`), which a server-to-server request just
// ignores. This is now the primary source for the fodder-leg odds the Freeze Builder needs
// (skybet-bfex-lib.js's resolveSkyOdds() direct-scrape path stays in place as a fallback for
// whenever it works again, but nothing here depends on it).
//
// NOT a source for Acca-Freeze eligibility — OddsMonkey has no concept of SkyBet's specific
// promo. That's handled separately (VA-pasted list, see index.html's Freeze Builder).
//
// Data shape returned by fetchSkyBackOdds(): array of
//   { eventId, eventName, startAt, selections: [{ name, odds, updatedAt }] }
// one row per Betfair-style fixture, deduped across the multiple exchange-paired rows
// OddsMonkey's API actually returns per selection (we only want the `back` block, which is
// identical across every one of those duplicate rows for a given eventId+selectionId).

const { teamEq } = require('./team-name-match');

const OM_ENDPOINT = 'https://api.oddsplatform.profitaccumulator.com/graphql';
const OM_HEADERS = {
  'content-type': 'application/json',
  'accept': '*/*',
  'origin': 'https://oddsmatcher.oddsmonkey.com',
  'referer': 'https://oddsmatcher.oddsmonkey.com/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
};
const OM_QUERY = `query GetBestMatches($ratingType: String!, $bookmaker: [String], $exchange: [String], $permittedSports: [String], $permittedMarketGroups: [String], $minOdds: String, $maxOdds: String, $minRating: String, $maxRating: String, $minLiquidity: String, $timeframeStart: String, $timeframeEnd: String, $searchByEventName: String, $excludeDraw: Boolean, $limit: Int, $cap: Int, $updatedWithinSeconds: Int, $skip: Int, $permittedEventGroups: [String], $commissionRates: [CommissionRate], $permittedCountries: [String], $permittedEventIds: [String]) {
  getBestMatches(
    ratingType: $ratingType
    bookmaker: $bookmaker
    exchange: $exchange
    permittedSports: $permittedSports
    permittedMarketGroups: $permittedMarketGroups
    minOdds: $minOdds
    maxOdds: $maxOdds
    minRating: $minRating
    maxRating: $maxRating
    minLiquidity: $minLiquidity
    timeframeStart: $timeframeStart
    timeframeEnd: $timeframeEnd
    searchByEventName: $searchByEventName
    excludeDraw: $excludeDraw
    limit: $limit
    cap: $cap
    updatedWithinSeconds: $updatedWithinSeconds
    skip: $skip
    permittedEventGroups: $permittedEventGroups
    commissionRates: $commissionRates
    permittedCountries: $permittedCountries
    permittedEventIds: $permittedEventIds
  ) {
    eventName
    id
    startAt
    selectionId
    marketId
    eventId
    back { updatedAt odds fetchedAt bookmaker { code } }
    selectionName
  }
}
`;
const WINDOW_SECONDS = 8 * 86400; // 8 days of "updated within" — comfortably covers the 5-day fodder window
const CAP = 4000; // observed ~1500 rows for skybet+soccer+match-odds today; well under this

let cache = null; // { ts, rows }
const TTL_MS = 3 * 60 * 1000;

async function fetchRaw() {
  const body = JSON.stringify({
    operationName: 'GetBestMatches',
    variables: {
      bookmaker: ['skybet'], exchange: ['betfairexchange'],
      minRating: null, maxRating: '100', timeframeStart: null, timeframeEnd: null,
      searchByEventName: null, limit: CAP, cap: CAP, updatedWithinSeconds: WINDOW_SECONDS,
      excludeDraw: false, minLiquidity: null, ratingType: 'rating', minOdds: null, maxOdds: null,
      permittedMarketGroups: ['match-odds'], permittedSports: ['soccer'], skip: 0,
      permittedEventGroups: [], commissionRates: [], permittedCountries: [], permittedEventIds: [],
    },
    query: OM_QUERY,
  });
  const res = await fetch(OM_ENDPOINT, { method: 'POST', headers: OM_HEADERS, body });
  if (!res.ok) throw new Error('oddsmonkey HTTP ' + res.status);
  const j = await res.json();
  if (j.errors) throw new Error('oddsmonkey graphql: ' + JSON.stringify(j.errors));
  return (j.data && j.data.getBestMatches) || [];
}

// Group OddsMonkey's per-(eventId,selectionId,exchange) rows into one row per fixture, deduped
// on selectionId (every exchange-paired duplicate carries the same `back` block).
async function fetchSkyBackOdds() {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.rows;
  const raw = await fetchRaw();
  const byEvent = new Map();
  for (const r of raw) {
    if (!r.back || r.back.odds == null) continue;
    let ev = byEvent.get(r.eventId);
    if (!ev) { ev = { eventId: r.eventId, eventName: r.eventName, startAt: r.startAt, selections: new Map() }; byEvent.set(r.eventId, ev); }
    const prev = ev.selections.get(r.selectionId);
    if (!prev || Date.parse(r.back.updatedAt || 0) > Date.parse(prev.updatedAt || 0)) {
      ev.selections.set(r.selectionId, { name: r.selectionName, odds: parseFloat(r.back.odds), updatedAt: r.back.updatedAt });
    }
  }
  const rows = [...byEvent.values()].map(ev => ({ ...ev, selections: [...ev.selections.values()] }));
  cache = { ts: Date.now(), rows };
  return rows;
}

// Match a Betfair-style fixture {home, away, startTime} against the OddsMonkey rows and
// return { odds: {home, draw, away}, updatedAt } | null — same shape as skybet-bfex-lib.js's
// other SkyBet sources expect for fx.sky.odds.
function findOddsMonkeySky(fx, omRows) {
  const bt = fx.startTime ? Date.parse(fx.startTime) : null;
  let best = null, bestDelta = Infinity;
  for (const ev of omRows) {
    const st = ev.startAt ? Date.parse(ev.startAt) : null;
    const delta = (bt && st) ? Math.abs(bt - st) : 0;
    if (bt && st && delta > 6 * 3600e3) continue; // same 6h sanity window as findSky()
    const [a, b] = (ev.eventName || '').split(/ v /i);
    if (!a || !b) continue;
    if (!((teamEq(fx.home, a) && teamEq(fx.away, b)) || (teamEq(fx.home, b) && teamEq(fx.away, a)))) continue;
    if (delta < bestDelta) { best = ev; bestDelta = delta; }
  }
  if (!best) return null;

  const odds = { home: null, draw: null, away: null };
  let updatedAt = null;
  for (const sel of best.selections) {
    let side = null;
    if (/^draw$/i.test(sel.name)) side = 'draw';
    else if (teamEq(fx.home, sel.name)) side = 'home';
    else if (teamEq(fx.away, sel.name)) side = 'away';
    if (!side) continue;
    odds[side] = sel.odds;
    if (!updatedAt || Date.parse(sel.updatedAt) > Date.parse(updatedAt)) updatedAt = sel.updatedAt;
  }
  if (odds.home == null && odds.away == null) return null;
  return { odds, updatedAt };
}

module.exports = { fetchSkyBackOdds, findOddsMonkeySky };

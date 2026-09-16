// netlify/functions/betfair-match-odds.js
// Football MATCH_ODDS (1X2) prices from Betfair Exchange, for the PricedUp win-acca +EV scan
// (oc-scraper/scripts/pricedup_acca_ev_scan.py — see that file's docstring: PricedUp's
// "Team A & Team B Both To Win" / "Team A, B & C All To Win" boosts priced by multiplying
// each team's own independent match-win BFEX fair odds together). Reuses the same cert-based
// login as netlify/functions/betfair.js (deliberately duplicated, not shared — see that
// file's own header note on why).
//
// action=team-win&team=<name>:
//   Finds the team's own fixture by searching Betfair events for that team name alone (no
//   opponent needed — PricedUp's acca text only ever gives team names, not who they're
//   playing), fetches that match's MATCH_ODDS market, and returns raw runner data
//   (totalMatched/lastPriceTraded/back/lay) for the team's own "to win" runner — deriving the
//   actual fair odds from that (bfex_fair.derive_bfex_fair) is left to the Python caller,
//   same split as betfair-dogs.js/betfair-horses.js.
//
// Six more actions added 2026-09-15 for oc-scraper's football_boost_scan.py — the "other"
// per-match boosts (Win To Nil, HT/FT, Correct Score, Over 2.5, BTTS, Win & BTTS) that PricedUp/
// StarSports/PlanetSportBet/DragonBet run alongside the plain win-accas, confirmed live to all
// exist as their own genuine BFEX markets on every fixture probed (2026-09-15, tonight's EFL
// Cup card). Unlike team-win, these need BOTH team names (home & away) to find the fixture
// precisely, same as betfair.js's own home/away search — a single-team search is too loose once
// the market itself (not just the runner within it) has to be picked out by name.
//   action=win-to-nil&home=<H>&away=<A>&team=<T>        — "<T> Win to Nil", runner "Yes"
//   action=draw&home=<H>&away=<A>                       — "Match Odds", runner "The Draw"
//   action=over25&home=<H>&away=<A>                     — "Over/Under 2.5 Goals", runner "Over 2.5 Goals"
//   action=btts&home=<H>&away=<A>                       — "Both teams to Score?", runner "Yes"
//   action=correct-score&home=<H>&away=<A>&homeScore=<N>&awayScore=<M>
//                                                         — "Correct Score", runner "<N> - <M>"
//   action=ht-ft&home=<H>&away=<A>&ht=<team-or-Draw>&ft=<team-or-Draw>
//                                                         — "Half Time/Full Time", runner "<ht>/<ft>"
//   action=win-and-btts&home=<H>&away=<A>&team=<T>       — "Match Odds and Both teams to Score",
//                                                            runner "<T>/Yes"
// All six return the same {ok, eventName, marketName, marketId, runner} shape as team-win — the
// runner's own name in each combo market (e.g. "Draw/Arsenal", "Arsenal/Yes") uses Betfair's own
// short club names, not the caller's, so matching is fuzzy on each "/"-separated side rather
// than an exact string compare.
const https = require('https');
const fs = require('fs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};
const BFEX_BASE = 'https://api.betfair.com/exchange/betting/rest/v1.0';
const FOOTBALL_EVENT_TYPE_ID = '1';

const CERT = fs.readFileSync('/root/client-2048.crt');
const KEY  = fs.readFileSync('/root/client-2048.key');

function directFetch(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const reqOptions = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      ...(options.cert ? { cert: options.cert, key: options.key } : {})
    };
    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({
        status: res.statusCode,
        text: () => Promise.resolve(data),
      }));
      res.on('error', reject); // see betfair.js's directFetch for why this matters
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function getSessionToken(appKey) {
  const username = process.env.BFEX_USERNAME;
  const password = process.env.BFEX_PASSWORD;
  if (!username || !password) throw new Error('BFEX_USERNAME or BFEX_PASSWORD not set');
  const body = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  const res = await directFetch('https://identitysso-cert.betfair.com/api/certlogin', {
    method: 'POST', cert: CERT, key: KEY,
    headers: { 'X-Application': appKey, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    body
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
    headers: { 'Content-Type': 'application/json', 'X-Application': appKey, 'X-Authentication': session, 'Accept': 'application/json' },
    body: JSON.stringify(params)
  });
  const text = await res.text();
  if (text.trim().startsWith('<')) throw new Error('SESSION_EXPIRED');
  const data = JSON.parse(text);
  if (data.faultcode) throw new Error(data.faultstring || JSON.stringify(data));
  return data;
}

// Same fuzzy team-name matching as betfair.js, plus a real edit-distance-<=1 fallback (not
// just betfair.js's own substring/word-overlap check) — confirmed live 2026-09-14 needed for
// a mid-string spelling difference like PricedUp's "Villareal" vs Betfair's "Villarreal"
// (betfair.js's own checks only ever catch a difference right at the end of the name).
function norm(n) {
  return (n || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
    .replace(/\butd\b/g, 'united');
}
function editDistanceAtMostOne(a, b) {
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length === l.length) {
    let diff = 0;
    for (let i = 0; i < s.length; i++) if (s[i] !== l[i]) diff++;
    return diff <= 1;
  }
  let i = 0, j = 0, skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; continue; }
    if (!skipped) { skipped = true; j++; continue; }
    return false;
  }
  return true;
}
function fuzzyTeamMatch(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb || nb.includes(na) || na.includes(nb)) return true;
  if (editDistanceAtMostOne(na, nb)) return true;
  const wa = na.split(' '), wb = nb.split(' ');
  const [shorter, longer] = wa.length <= wb.length ? [wa, nb] : [wb, na];
  return shorter.filter(w => w.length > 1).every(w => longer.includes(w));
}
const TEAM_SEARCH_ALIASES = {
  'manchester united': 'Man Utd', 'manchester city': 'Man City',
  'wolverhampton wanderers': 'Wolves', 'sheffield united': 'Sheff Utd',
  'nottingham forest': 'Nottm Forest', 'west bromwich albion': 'West Brom',
  'west ham united': 'West Ham',
  // Confirmed live 2026-09-14 needed for PricedUp's own team-name spelling specifically —
  // Betfair's event name is just "Inter", not the full club name PricedUp displays.
  'internazionale': 'Inter', 'inter milan': 'Inter',
};
// Common club-name prefixes Betfair usually drops from its own event names (e.g. "AS Roma"
// -> "Torino v Roma", not "Torino v AS Roma") — confirmed live 2026-09-14 "AS Roma" returned
// zero events at all, the generic two-letter "AS" first-word fallback isn't useful either
// (matches unrelated clubs like "AS FAP"). Stripping the prefix and also trying the last
// word (works for "AS Roma"->"Roma" the same way betfair.js's first-word fallback already
// works for "Tottenham Hotspur"->"Tottenham") covers this without a full alias table.
const CLUB_PREFIX_RE = /^(AS|FC|CD|SC|SS|US|AC|CA|RC|CF)\s+/i;
function searchQueries(name) {
  const alias = TEAM_SEARCH_ALIASES[name.toLowerCase().trim()];
  const words = name.trim().split(/\s+/);
  const firstWord = words[0];
  const lastWord = words[words.length - 1];
  const prefixStripped = name.trim().replace(CLUB_PREFIX_RE, '');
  return [...new Set([alias, name, prefixStripped, firstWord, lastWord].filter(Boolean))];
}

// A candidate event is only usable as a PRE-MATCH win-acca/boost leg if it hasn't kicked off
// yet and isn't implausibly far away (these scans are always for tonight's/tomorrow's card,
// never a fixture days out). Without this, findTeamWin/findEventByHomeAway happily returned
// whichever candidate sorted "soonest" even when that meant an ALREADY-IN-PLAY match — confirmed
// live 2026-09-16: Everton/Man Utd/Aston Villa/Sunderland/Leverkusen all had already kicked off
// (up to 46 min earlier) by the time a later scan cycle re-priced their win-acca/win-to-nil
// legs off BFEX's now-IN-PLAY price (e.g. Man Utd's pre-match ~1.70 had collapsed to 1.16 once
// they were already winning), producing nonsense EV (+139%, +44%, +24%) against a bookmaker
// price that was only ever meant to be compared pre-match. Separately, Celta Vigo's real
// tonight fixture wasn't found by search at all (likely not listed as an in-play event the same
// way), and with no future bound the code fell back to Celta Vigo's NEXT domestic match three
// days later — an unrelated, un-boosted price used as if it were tonight's. Both failure modes
// are the same root cause: no plausibility bound on which candidate counts as "the match". A
// leg that fails this now just goes unresolved, same as any other unresolvable leg — the
// existing "drop the whole acca rather than guess" rule (see every acca scan's own docstring)
// already handles it correctly from there; a missed alert is far better than a false one.
const MAX_FUTURE_KICKOFF_MS = 48 * 60 * 60 * 1000; // 48h — comfortably covers same-night/next-day fixtures, excludes a match days out
function isPlausiblePrematchKickoff(openDateIso) {
  const t = new Date(openDateIso).getTime();
  if (!Number.isFinite(t)) return false;
  const delta = t - Date.now();
  return delta > 0 && delta <= MAX_FUTURE_KICKOFF_MS;
}

async function findTeamWin(team, appKey, session) {
  // Alias-resolved form (e.g. "Manchester United" -> "Man Utd") — used for every fuzzy-match
  // check below, not just the search query. Betfair's own event/runner names use the
  // abbreviation, and fuzzyTeamMatch can't bridge "Manchester" -> "Man" on its own (not a
  // substring, edit-distance is way over 1, and the word-overlap check needs an exact word
  // match, not a partial one) — confirmed live 2026-09-16: searchQueries(team) tries the alias
  // first and Betfair happily returns "Man Utd v Brighton", but the hits filter and runnerMeta
  // lookup below were still fuzzy-matching against the raw, un-aliased `team` ("Manchester
  // United"), so the correctly-found event got filtered straight back out and every acca/boost
  // referencing "Manchester United" by its full name failed with "event not found" even though
  // the alias table already had the answer.
  const teamM = TEAM_SEARCH_ALIASES[team.toLowerCase().trim()] || team;
  // Searching by ONE team name (no opponent — PricedUp's acca text never gives one) means a
  // common club can turn up several of its own fixtures at once (today's match plus a later
  // gameweek, etc.) — confirmed live 2026-09-14 "AS Roma" alone matched both "Torino v Roma"
  // (today) and a later "Roma v Inter". Collect every candidate across all query attempts
  // and take the one with the SOONEST kickoff (event.openDate) rather than just the first
  // hit, so it's always today's/next match, not an arbitrary later one.
  let candidates = [], events = [];
  for (const q of searchQueries(team)) {
    events = await bfCall('listEvents', { filter: { eventTypeIds: [FOOTBALL_EVENT_TYPE_ID], textQuery: q } }, appKey, session);
    const hits = (events || []).filter(e => {
      const name = e.event?.name || '';
      if (/\(w\)/i.test(name)) return false; // exclude women's fixtures — same club names, wrong market
      // Exclude youth/reserve fixtures (same club name, wrong market/liquidity entirely) —
      // confirmed live 2026-09-14 "Como" alone matched "Roma U20 v Como U20" ahead of the
      // real "Como v Parma" senior match.
      if (/\bU1[6-9]\b|\bU2[0-3]\b|\byouth\b|\breserves?\b/i.test(name)) return false;
      if (!isPlausiblePrematchKickoff(e.event?.openDate)) return false; // already kicked off, or implausibly far out
      const parts = name.split(' v ');
      if (parts.length !== 2) return false;
      return fuzzyTeamMatch(teamM, parts[0]) || fuzzyTeamMatch(teamM, parts[1]);
    });
    if (hits.length) { candidates = hits; break; }
  }
  if (!candidates.length) return { error: `event not found for team: ${team}`, available: (events || []).slice(0, 10).map(e => e.event?.name) };
  candidates.sort((a, b) => new Date(a.event.openDate) - new Date(b.event.openDate));
  const match = candidates[0];

  const eventId = match.event.id;
  const catalogue = await bfCall('listMarketCatalogue', {
    filter: { eventIds: [eventId], marketTypeCodes: ['MATCH_ODDS'] },
    marketProjection: ['RUNNER_DESCRIPTION'],
    maxResults: 5,
  }, appKey, session);
  if (!catalogue?.length) return { error: 'no MATCH_ODDS market found', eventName: match.event.name };

  const marketId = catalogue[0].marketId;
  const runnerMeta = catalogue[0].runners.find(r => fuzzyTeamMatch(teamM, r.runnerName));
  if (!runnerMeta) return { error: `runner not found for team: ${team}`, eventName: match.event.name, runners: catalogue[0].runners.map(r => r.runnerName) };

  const books = await bfCall('listMarketBook', {
    marketIds: [marketId],
    priceProjection: { priceData: ['EX_BEST_OFFERS', 'EX_TRADED'] },
  }, appKey, session);
  const runnerBook = (books[0]?.runners || []).find(r => r.selectionId === runnerMeta.selectionId);

  return {
    eventName: match.event.name,
    startTime: match.event.openDate,  // UTC ISO — caller converts to local (see bfex_fair.to_local_hhmm)
    marketId,
    runner: {
      totalMatched: runnerBook?.totalMatched ?? 0,
      lastPriceTraded: runnerBook?.lastPriceTraded ?? null,
      back: (runnerBook?.ex?.availableToBack ?? []).slice(0, 3).map(p => ({ price: p.price, size: p.size })),
      lay: (runnerBook?.ex?.availableToLay ?? []).slice(0, 3).map(p => ({ price: p.price, size: p.size })),
    },
  };
}

// Finds the ONE fixture matching both team names — precise, unlike findTeamWin's single-name
// search, because the six actions below need to pick a specific MARKET out by name (e.g. "Win
// to Nil", "Correct Score") on top of the runner, so a loosely-matched wrong fixture would fail
// far less obviously than it does for a plain MATCH_ODDS lookup. Same soonest-kickoff tie-break
// as findTeamWin, searched off the home team's name (matches betfair.js's own approach).
async function findEventByHomeAway(home, away, appKey, session) {
  // Same alias-resolved-form fix as findTeamWin above — matching must use the abbreviation
  // Betfair actually names its events with, not just search for it.
  const homeM = TEAM_SEARCH_ALIASES[home.toLowerCase().trim()] || home;
  const awayM = TEAM_SEARCH_ALIASES[away.toLowerCase().trim()] || away;
  let candidates = [];
  for (const q of searchQueries(home)) {
    const events = await bfCall('listEvents', { filter: { eventTypeIds: [FOOTBALL_EVENT_TYPE_ID], textQuery: q } }, appKey, session);
    candidates = (events || []).filter(e => {
      const name = e.event?.name || '';
      if (/\(w\)/i.test(name)) return false;
      if (/\bU1[6-9]\b|\bU2[0-3]\b|\byouth\b|\breserves?\b/i.test(name)) return false;
      if (!isPlausiblePrematchKickoff(e.event?.openDate)) return false; // already kicked off, or implausibly far out
      const parts = name.split(' v ');
      if (parts.length !== 2) return false;
      return (fuzzyTeamMatch(homeM, parts[0]) && fuzzyTeamMatch(awayM, parts[1])) ||
             (fuzzyTeamMatch(awayM, parts[0]) && fuzzyTeamMatch(homeM, parts[1]));
    });
    if (candidates.length) break;
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => new Date(a.event.openDate) - new Date(b.event.openDate));
  return candidates[0].event;
}

// Generic "find one market by name, one runner within it by name" fetch — every one of the six
// new boost actions is this same shape, just with a different marketNameTest/runnerTest pair.
// Lists ALL of the event's markets (no marketTypeCodes filter — these boost markets don't all
// have stable/memorable codes the way MATCH_ODDS does, and matching on Betfair's own displayed
// marketName is simpler and just as reliable) rather than guessing a market type code.
async function findEventMarketRunner(eventId, eventName, marketNameTest, runnerTest, appKey, session) {
  const catalogue = await bfCall('listMarketCatalogue', {
    filter: { eventIds: [eventId] },
    marketProjection: ['RUNNER_DESCRIPTION'],
    maxResults: 300,
  }, appKey, session);
  const market = (catalogue || []).find(m => marketNameTest(m.marketName || ''));
  if (!market) return { error: 'market not found', eventName, available: (catalogue || []).map(m => m.marketName) };
  const runnerMeta = (market.runners || []).find(r => runnerTest(r.runnerName || ''));
  if (!runnerMeta) return { error: 'runner not found', eventName, marketName: market.marketName, runners: (market.runners || []).map(r => r.runnerName) };

  const books = await bfCall('listMarketBook', {
    marketIds: [market.marketId],
    priceProjection: { priceData: ['EX_BEST_OFFERS'] },
  }, appKey, session);
  const runnerBook = (books[0]?.runners || []).find(r => r.selectionId === runnerMeta.selectionId);

  return {
    eventName,
    marketName: market.marketName,
    marketId: market.marketId,
    runner: {
      totalMatched: runnerBook?.totalMatched ?? 0,
      lastPriceTraded: runnerBook?.lastPriceTraded ?? null,
      back: (runnerBook?.ex?.availableToBack ?? []).slice(0, 3).map(p => ({ price: p.price, size: p.size })),
      lay: (runnerBook?.ex?.availableToLay ?? []).slice(0, 3).map(p => ({ price: p.price, size: p.size })),
    },
  };
}

// A "/"-separated combo runner (Half Time/Full Time, Match Odds and BTTS) uses Betfair's own
// short club name on each side, not the caller's — split and fuzzy-match each side rather than
// comparing the whole runner name as one string.
function splitSlashRunner(runnerName) {
  const parts = (runnerName || '').split('/');
  return parts.length === 2 ? [parts[0].trim(), parts[1].trim()] : null;
}
function matchesTeamOrDraw(expected, actual) {
  return expected.toLowerCase().trim() === 'draw' ? /^draw$/i.test(actual) : fuzzyTeamMatch(expected, actual);
}

async function runAction(action, params, appKey, session) {
  if (action === 'team-win') {
    if (!params.team) return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'team required' }) };
    const result = await findTeamWin(params.team, appKey, session);
    if (result.error) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, ...result }) };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, ...result }) };
  }

  const BOOST_ACTIONS = ['win-to-nil', 'draw', 'over25', 'btts', 'correct-score', 'ht-ft', 'win-and-btts'];
  if (BOOST_ACTIONS.includes(action)) {
    const { home, away, team, homeScore, awayScore, ht, ft } = params;
    if (!home || !away) return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'home and away required' }) };

    const event = await findEventByHomeAway(home, away, appKey, session);
    if (!event) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: `event not found: ${home} v ${away}` }) };

    let marketNameTest, runnerTest;
    if (action === 'win-to-nil') {
      if (!team) return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'team required' }) };
      marketNameTest = n => /win to nil/i.test(n) && fuzzyTeamMatch(team, n.replace(/win to nil/i, '').trim());
      runnerTest = n => /^yes$/i.test(n.trim());
    } else if (action === 'draw') {
      marketNameTest = n => n.trim().toLowerCase() === 'match odds';
      runnerTest = n => /draw/i.test(n);
    } else if (action === 'over25') {
      marketNameTest = n => n.trim().toLowerCase() === 'over/under 2.5 goals';
      runnerTest = n => /^over/i.test(n.trim());
    } else if (action === 'btts') {
      marketNameTest = n => /^both teams to score\??$/i.test(n.trim());
      runnerTest = n => /^yes$/i.test(n.trim());
    } else if (action === 'correct-score') {
      if (homeScore == null || awayScore == null) return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'homeScore and awayScore required' }) };
      marketNameTest = n => n.trim().toLowerCase() === 'correct score';
      const target = `${homeScore} - ${awayScore}`;
      runnerTest = n => n.trim() === target;
    } else if (action === 'ht-ft') {
      if (!ht || !ft) return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'ht and ft required' }) };
      marketNameTest = n => n.trim().toLowerCase() === 'half time/full time';
      runnerTest = n => {
        const sides = splitSlashRunner(n);
        return !!sides && matchesTeamOrDraw(ht, sides[0]) && matchesTeamOrDraw(ft, sides[1]);
      };
    } else if (action === 'win-and-btts') {
      if (!team) return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'team required' }) };
      marketNameTest = n => n.trim().toLowerCase() === 'match odds and both teams to score';
      runnerTest = n => {
        const sides = splitSlashRunner(n);
        return !!sides && fuzzyTeamMatch(team, sides[0]) && /^yes$/i.test(sides[1]);
      };
    }

    const result = await findEventMarketRunner(event.id, event.name, marketNameTest, runnerTest, appKey, session);
    if (result.error) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, startTime: event.openDate, ...result }) };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, startTime: event.openDate, ...result }) };
  }

  return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: `unknown action: ${action}` }) };
}

let cachedSession = null;
const SESSION_TTL_MS = 3 * 60 * 60 * 1000;

async function getCachedSessionToken(appKey) {
  if (cachedSession && cachedSession.appKey === appKey && (Date.now() - cachedSession.obtainedAt) < SESSION_TTL_MS) {
    return cachedSession.token;
  }
  const token = await getSessionToken(appKey);
  cachedSession = { token, appKey, obtainedAt: Date.now() };
  return token;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const appKey = process.env.BFEX_APP_KEY;
  if (!appKey) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'BFEX_APP_KEY not set' }) };

  const params = event.queryStringParameters || {};
  const { action } = params;

  try {
    const session = await getCachedSessionToken(appKey);
    try {
      return await runAction(action, params, appKey, session);
    } catch (err) {
      if (err.message === 'SESSION_EXPIRED') {
        cachedSession = null;
        const freshSession = await getCachedSessionToken(appKey);
        return await runAction(action, params, appKey, freshSession);
      }
      throw err;
    }
  } catch (err) {
    const expired = err.message === 'SESSION_EXPIRED';
    return {
      statusCode: expired ? 200 : 500, headers: CORS,
      body: JSON.stringify({ ok: false, error: err.message, sessionExpired: expired })
    };
  }
};

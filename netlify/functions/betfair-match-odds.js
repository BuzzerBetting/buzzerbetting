// netlify/functions/betfair-match-odds.js
// Football MATCH_ODDS (1X2) prices from Betfair Exchange, for the PricedUp win-acca +EV scan
// (oc-scraper/scripts/pricedup_acca_ev_scan.py — see that file's docstring: PricedUp's
// "Team A & Team B Both To Win" / "Team A, B & C All To Win" boosts priced by multiplying
// each team's own independent match-win BFEX fair odds together). Reuses the same cert-based
// login as netlify/functions/betfair.js (deliberately duplicated, not shared — see that
// file's own header note on why).
//
// One action, via ?action=team-win&team=<name>:
//   Finds the team's own fixture by searching Betfair events for that team name alone (no
//   opponent needed — PricedUp's acca text only ever gives team names, not who they're
//   playing), fetches that match's MATCH_ODDS market, and returns raw runner data
//   (totalMatched/lastPriceTraded/back/lay) for the team's own "to win" runner — deriving the
//   actual fair odds from that (bfex_fair.derive_bfex_fair) is left to the Python caller,
//   same split as betfair-dogs.js/betfair-horses.js.
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

async function findTeamWin(team, appKey, session) {
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
      const parts = name.split(' v ');
      if (parts.length !== 2) return false;
      return fuzzyTeamMatch(team, parts[0]) || fuzzyTeamMatch(team, parts[1]);
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
  const runnerMeta = catalogue[0].runners.find(r => fuzzyTeamMatch(team, r.runnerName));
  if (!runnerMeta) return { error: `runner not found for team: ${team}`, eventName: match.event.name, runners: catalogue[0].runners.map(r => r.runnerName) };

  const books = await bfCall('listMarketBook', {
    marketIds: [marketId],
    priceProjection: { priceData: ['EX_BEST_OFFERS', 'EX_TRADED'] },
  }, appKey, session);
  const runnerBook = (books[0]?.runners || []).find(r => r.selectionId === runnerMeta.selectionId);

  return {
    eventName: match.event.name,
    marketId,
    runner: {
      totalMatched: runnerBook?.totalMatched ?? 0,
      lastPriceTraded: runnerBook?.lastPriceTraded ?? null,
      back: (runnerBook?.ex?.availableToBack ?? []).slice(0, 3).map(p => ({ price: p.price, size: p.size })),
      lay: (runnerBook?.ex?.availableToLay ?? []).slice(0, 3).map(p => ({ price: p.price, size: p.size })),
    },
  };
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

async function runAction(action, team, appKey, session) {
  if (action === 'team-win') {
    if (!team) return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'team required' }) };
    const result = await findTeamWin(team, appKey, session);
    if (result.error) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, ...result }) };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, ...result }) };
  }
  return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'action must be "team-win"' }) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const appKey = process.env.BFEX_APP_KEY;
  if (!appKey) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'BFEX_APP_KEY not set' }) };

  const { action, team } = event.queryStringParameters || {};

  try {
    const session = await getCachedSessionToken(appKey);
    try {
      return await runAction(action, team, appKey, session);
    } catch (err) {
      if (err.message === 'SESSION_EXPIRED') {
        cachedSession = null;
        const freshSession = await getCachedSessionToken(appKey);
        return await runAction(action, team, appKey, freshSession);
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

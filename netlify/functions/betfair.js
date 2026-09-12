// netlify/functions/betfair.js
const https = require('https');
const fs = require('fs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};
const BFEX_BASE = 'https://api.betfair.com/exchange/betting/rest/v1.0';

// Certificate-based login (identitysso-cert) rather than the delayed-key interactive
// login — avoids periodic re-login for a long-running process. Cert lives on the DO
// server only; both files are gitignored/untracked, not part of the repo.
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
        json: () => Promise.resolve(JSON.parse(data))
      }));
      // Without this, a socket error after headers arrive (timeout, reset mid-body — real,
      // seen live 2026-09-12: repeated ETIMEDOUT crashing the whole server, not just this
      // call) fires 'error' on `res` with no listener, which Node throws as an uncaught
      // exception with no global handler anywhere in this app. reject() instead just fails
      // this one promise, caught by every caller's existing try/catch.
      res.on('error', reject);
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
    method: 'POST',
    cert: CERT,
    key: KEY,
    headers: {
      'X-Application': appKey,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    },
    body
  });

  const text = await res.text();
  console.log('Login response:', text.substring(0, 300));
  let data;
  try { data = JSON.parse(text); }
  catch(e) { throw new Error('Login returned non-JSON: ' + text.substring(0, 200)); }
  if (data.loginStatus !== 'SUCCESS') throw new Error(`Login failed: ${data.loginStatus}`);
  return data.sessionToken;
}

// This is called once per fixture by every +EV/boost/DDHH scan iterating today's card, so with
// no caching it was doing a full certlogin handshake per fixture per scan — the actual source
// of a 2026-09-12 CPU/memory incident (see betfair-dogs.js / betfair-f1.js, which already had
// this same fix). Reuse one session across requests, only re-logging in once it's stale or
// Betfair itself reports it's expired (see the SESSION_EXPIRED retry in the handler below).
let cachedSession = null; // { token, appKey, obtainedAt }
const SESSION_TTL_MS = 3 * 60 * 60 * 1000; // conservative — real Betfair sessions last longer
async function getCachedSessionToken(appKey) {
  if (cachedSession && cachedSession.appKey === appKey && (Date.now() - cachedSession.obtainedAt) < SESSION_TTL_MS) {
    return cachedSession.token;
  }
  const token = await getSessionToken();
  cachedSession = { token, appKey, obtainedAt: Date.now() };
  return token;
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
    body: JSON.stringify(params)
  });
  const text = await res.text();
  console.log(`[BF] ${method} status:${res.status} body:`, text.substring(0, 300));
  if (text.trim().startsWith('<')) throw new Error('SESSION_EXPIRED');
  const data = JSON.parse(text);
  if (data.faultcode) throw new Error(data.faultstring || JSON.stringify(data));
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const appKey = process.env.BFEX_APP_KEY;
  if (!appKey) return {
    statusCode: 200, headers: CORS,
    body: JSON.stringify({ ok: false, error: 'BFEX_APP_KEY not set' })
  };

  const { home, away } = event.queryStringParameters || {};
  if (!home || !away) return {
    statusCode: 400, headers: CORS,
    body: JSON.stringify({ ok: false, error: 'home and away required' })
  };

  // Betfair's own event names are often abbreviated ("Man Utd" vs our "Man United"),
  // so a literal "home v away" textQuery can miss real matches. Search on the home
  // team alone (a much broader net) and fuzzy-match both teams client-side instead.
  function norm(n) {
    return (n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
      .replace(/\butd\b/g, 'united'); // Betfair favours "Utd" — normalise so it matches "United"
  }
  function fuzzyTeamMatch(a, b) {
    const na = norm(a), nb = norm(b);
    if (!na || !nb) return false;
    if (na === nb || nb.includes(na) || na.includes(nb)) return true;
    // Word-overlap fallback: every word of the shorter name appears in the longer one
    const wa = na.split(' '), wb = nb.split(' ');
    const [shorter, longer] = wa.length <= wb.length ? [wa, nb] : [wb, na];
    return shorter.filter(w => w.length > 1).every(w => longer.includes(w));
  }

  // 2026-09-12 fix: the fuzzy match above only ever runs against whatever Betfair's OWN
  // textQuery search decided to return — and that search can come back completely empty
  // for a club's full FotMob name, not just an abbreviated name a client-side fuzzy check
  // could still catch. Confirmed live: "Manchester United", "Wolverhampton Wanderers",
  // "Sheffield United" and "Nottingham Forest" all returned zero events; every player in
  // that fixture then silently fell back to the weaker OC+BB combo source for the WHOLE
  // match, not just one player, because fetch_bfex_markets() got {} back. A small alias
  // table for the clubs Betfair renames outright, plus a first-word retry for everything
  // else (catches "Tottenham Hotspur"->"Tottenham", "Newcastle United"->"Newcastle", etc.),
  // fixes the common cases without needing every club worldwide mapped by hand.
  const TEAM_SEARCH_ALIASES = {
    'manchester united': 'Man Utd', 'manchester city': 'Man City',
    'wolverhampton wanderers': 'Wolves', 'sheffield united': 'Sheff Utd',
    'nottingham forest': 'Nottm Forest', 'west bromwich albion': 'West Brom',
    'west ham united': 'West Ham',
  };
  function searchQueries(name) {
    const alias = TEAM_SEARCH_ALIASES[name.toLowerCase().trim()];
    const firstWord = name.trim().split(/\s+/)[0];
    return [...new Set([alias, name, firstWord].filter(Boolean))];
  }

  try {
    const session = await getCachedSessionToken(appKey);

    let events = [];
    let match = null;
    for (const q of searchQueries(home)) {
      events = await bfCall('listEvents', {
        filter: { eventTypeIds: ['1'], textQuery: q }
      }, appKey, session);
      match = (events || []).find(e => {
        const name = e.event?.name || '';
        if (/\(w\)/i.test(name)) return false; // exclude women's fixtures — same club names, wrong market
        const parts = name.split(' v ');
        if (parts.length !== 2) return false;
        return (fuzzyTeamMatch(home, parts[0]) && fuzzyTeamMatch(away, parts[1])) ||
               (fuzzyTeamMatch(away, parts[0]) && fuzzyTeamMatch(home, parts[1]));
      });
      if (match) break;
    }

    if (!match) return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: false, error: `Event not found: ${home} v ${away}`,
        available: (events || []).slice(0, 15).map(e => e.event?.name)
      })
    };

    const eventId = match.event.id;

    const catalogue = await bfCall('listMarketCatalogue', {
      filter: { eventIds: [eventId], marketTypeCodes: ['TO_SCORE', 'SHOTS_ON_TARGET_P1', 'FIRST_GOAL_SCORER', 'SHOWN_A_CARD'] },
      marketProjection: ['RUNNER_DESCRIPTION'],
      maxResults: 10
    }, appKey, session);

    if (!catalogue?.length) return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: false, error: 'No markets found', eventId })
    };

    const marketIds = catalogue.map(m => m.marketId);
    const books = await bfCall('listMarketBook', {
      marketIds,
      priceProjection: { priceData: ['EX_BEST_OFFERS'] },
    }, appKey, session);

    const marketMap = {};
    for (const m of catalogue) marketMap[m.marketId] = m;
    const markets = {};
    for (const book of (books || [])) {
      const meta = marketMap[book.marketId];
      if (!meta) continue;
      const players = [];
      for (const runner of (book.runners || [])) {
        if (runner.status !== 'ACTIVE') continue;
        const runnerMeta = meta.runners?.find(r => r.selectionId === runner.selectionId);
        const name = runnerMeta?.runnerName ?? `Runner ${runner.selectionId}`;
        players.push({
          name,
          totalMatched: runner.totalMatched ?? 0,
          lastPriceTraded: runner.lastPriceTraded ?? null,
          back: (runner.ex?.availableToBack ?? []).slice(0, 3).map(p => ({ price: p.price, size: p.size })),
          lay: (runner.ex?.availableToLay ?? []).slice(0, 3).map(p => ({ price: p.price, size: p.size }))
        });
      }
      players.sort((a, b) => (a.back[0]?.price || 999) - (b.back[0]?.price || 999));
      markets[meta.marketName] = { marketId: book.marketId, players };
    }

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: true, eventId, markets })
    };

  } catch (err) {
    const expired = err.message === 'SESSION_EXPIRED';
    if (expired) cachedSession = null; // next call re-logs in instead of reusing the stale token
    return {
      statusCode: expired ? 200 : 500, headers: CORS,
      body: JSON.stringify({ ok: false, error: err.message, sessionExpired: expired })
    };
  }
};

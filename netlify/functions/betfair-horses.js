// netlify/functions/betfair-horses.js
// Horse racing WIN-market prices from Betfair Exchange, for the PricedUp horse-boost +EV
// scan (oc-scraper/scripts/pricedup_horse_ev_scan.py — see that file's docstring for the
// full picture: PricedUp's Enhanced Doubles priced by multiplying two independent runners'
// BFEX fair odds together). Reuses the same cert-based login as netlify/functions/betfair.js
// and betfair-dogs.js (deliberately duplicated rather than shared — those files are live,
// actively-used integrations; keeping this one fully self-contained means nothing here can
// regress them). Byte-for-byte the same shape as betfair-dogs.js, just eventTypeId=7 (Horse
// Racing) instead of 4339 (Greyhound Racing) and "N. Horse Name" cloth-number stripping
// instead of trap-number stripping — Betfair formats horse racing runner names the same way.
//
// Two actions, via ?action=:
//   races               — today's/next-12h GB/IE horse WIN markets (venue, start time,
//                          marketId) — the scan script matches its own track+time parse
//                          against these rather than this file doing any PricedUp-specific
//                          matching itself.
//   race&marketId=...   — runner names/back/lay/last-traded/totalMatched for one race, same
//                          shape bfex_fair.py's derive_bfex_fair (ported from
//                          index.html's deriveBfexFair) already expects.
const https = require('https');
const fs = require('fs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};
const BFEX_BASE = 'https://api.betfair.com/exchange/betting/rest/v1.0';
const HORSE_RACING_EVENT_TYPE_ID = '7';

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
      // See betfair.js's directFetch — without this, a socket error after headers arrive
      // crashes the whole process (unhandled 'error' event, no global handler anywhere here).
      res.on('error', reject);
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
    body: JSON.stringify(params)
  });
  const text = await res.text();
  if (text.trim().startsWith('<')) throw new Error('SESSION_EXPIRED');
  const data = JSON.parse(text);
  if (data.faultcode) throw new Error(data.faultstring || JSON.stringify(data));
  return data;
}

// Horse racing runner names come back from Betfair as "<cloth>. <Horse Name>" (e.g.
// "4. Satyress"), same shape as betfair-dogs.js's trap numbers.
function splitClothName(runnerName) {
  const m = String(runnerName || '').match(/^(\d+)\.\s*(.*)$/);
  return m ? { cloth: parseInt(m[1], 10), name: m[2] } : { cloth: null, name: runnerName };
}

async function listRaces(appKey, session) {
  const now = new Date();
  const to = new Date(now.getTime() + 12 * 60 * 60 * 1000); // next 12 hours — a PricedUp double's
  // two legs can be hours apart (e.g. 14:00 and 19:00), unlike the 6h window betfair-dogs.js
  // uses for its own single-race picker use case.
  const catalogue = await bfCall('listMarketCatalogue', {
    filter: {
      eventTypeIds: [HORSE_RACING_EVENT_TYPE_ID],
      marketTypeCodes: ['WIN'],
      marketCountries: ['GB', 'IE'],
      marketStartTime: { from: now.toISOString(), to: to.toISOString() },
    },
    marketProjection: ['EVENT', 'MARKET_START_TIME'],
    sort: 'FIRST_TO_START',
    maxResults: 200,
  }, appKey, session);

  return (catalogue || []).map(m => ({
    marketId: m.marketId,
    venue: m.event?.venue || m.event?.name || 'Unknown',
    startTime: m.marketStartTime,
  }));
}

async function getRace(marketId, appKey, session) {
  const catalogue = await bfCall('listMarketCatalogue', {
    filter: { marketIds: [marketId] },
    marketProjection: ['RUNNER_DESCRIPTION', 'EVENT', 'MARKET_START_TIME'],
    maxResults: 1,
  }, appKey, session);
  const meta = catalogue?.[0];
  if (!meta) throw new Error('Market not found');

  const books = await bfCall('listMarketBook', {
    marketIds: [marketId],
    priceProjection: { priceData: ['EX_BEST_OFFERS', 'EX_TRADED'] },
  }, appKey, session);
  const book = books?.[0];
  if (!book) throw new Error('No prices available for this market');

  const runners = (book.runners || [])
    .filter(r => r.status === 'ACTIVE')
    .map(r => {
      const runnerMeta = meta.runners?.find(rm => rm.selectionId === r.selectionId);
      const { cloth, name } = splitClothName(runnerMeta?.runnerName);
      return {
        selectionId: r.selectionId,
        cloth,
        name: name || `Runner ${r.selectionId}`,
        totalMatched: r.totalMatched ?? 0,
        lastPriceTraded: r.lastPriceTraded ?? null,
        back: (r.ex?.availableToBack ?? []).slice(0, 3).map(p => ({ price: p.price, size: p.size })),
        lay: (r.ex?.availableToLay ?? []).slice(0, 3).map(p => ({ price: p.price, size: p.size })),
      };
    })
    .sort((a, b) => (a.cloth ?? 99) - (b.cloth ?? 99));

  return {
    marketId,
    venue: meta.event?.venue || meta.event?.name || 'Unknown',
    startTime: meta.marketStartTime,
    runners,
  };
}

// Same reasoning/shape as betfair-dogs.js's cached session — this runs long-lived on the DO
// server under PM2, so a module-level cache avoids a fresh certlogin on every call.
let cachedSession = null; // { token, appKey, obtainedAt }
const SESSION_TTL_MS = 3 * 60 * 60 * 1000;

async function getCachedSessionToken(appKey) {
  if (cachedSession && cachedSession.appKey === appKey && (Date.now() - cachedSession.obtainedAt) < SESSION_TTL_MS) {
    return cachedSession.token;
  }
  const token = await getSessionToken(appKey);
  cachedSession = { token, appKey, obtainedAt: Date.now() };
  return token;
}

async function runAction(action, marketId, appKey, session) {
  if (action === 'races') {
    const races = await listRaces(appKey, session);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, races }) };
  }
  if (action === 'race') {
    if (!marketId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'marketId required' }) };
    const race = await getRace(marketId, appKey, session);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, race }) };
  }
  return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'action must be "races" or "race"' }) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const appKey = process.env.BFEX_APP_KEY;
  if (!appKey) return {
    statusCode: 200, headers: CORS,
    body: JSON.stringify({ ok: false, error: 'BFEX_APP_KEY not set' })
  };

  const { action, marketId } = event.queryStringParameters || {};

  try {
    const session = await getCachedSessionToken(appKey);
    try {
      return await runAction(action, marketId, appKey, session);
    } catch (err) {
      if (err.message === 'SESSION_EXPIRED') {
        cachedSession = null;
        const freshSession = await getCachedSessionToken(appKey);
        return await runAction(action, marketId, appKey, freshSession);
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

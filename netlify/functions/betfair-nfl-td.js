// netlify/functions/betfair-nfl-td.js
// Betfair Exchange NFL "Any Time Touchdown Scorer" fair prices, for the Bet Alerts "NFL TDs"
// feed (oc-scraper/scripts/nfl_td_scan.py fetches this from the DO server on localhost, turns
// each player's 1+ TD fair into Poisson 2+/3+/4+ fairs and compares NetBet/WH/Paddy Power).
//
// Cert-based login cloned from betfair-f1.js — self-contained on purpose, same as that file,
// so nothing here can regress the live football/F1 integrations. The cert only exists on the
// DO droplet, so this route only does anything real there.
//
// GET /api/betfair-nfl-td ->
//   { ok:true, events:[{ name, startTime, marketId, traded,
//       runners:[{ name, fair, back, backSize, lay, laySize, traded }] }] }
// `traded` on a runner is the £ matched on that player — the scanner only uses a player's fair
// once that's >= £300 (2026-10-02, user-specified). `fair` uses the same liquidity-gated
// back/lay midpoint as betfair-f1.js's fairPrice(); null when the book is too thin to say.
const https = require('https');
const fs = require('fs');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const BFEX_BASE = 'https://api.betfair.com/exchange/betting/rest/v1.0';
const AMERICAN_FOOTBALL_EVENT_TYPE_ID = '6423';
const LOOKAHEAD_DAYS = 7;

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
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, text: () => Promise.resolve(data) }));
      // See betfair.js's directFetch — without this, a socket error after headers arrive
      // crashes the whole process.
      res.on('error', reject);
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

let _cert = null, _key = null;
function readCert() {
  if (_cert && _key) return;
  _cert = fs.readFileSync('/root/client-2048.crt');
  _key = fs.readFileSync('/root/client-2048.key');
}

async function login(appKey) {
  readCert();
  const username = process.env.BFEX_USERNAME;
  const password = process.env.BFEX_PASSWORD;
  if (!username || !password) throw new Error('BFEX_USERNAME or BFEX_PASSWORD not set');
  const body = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  const res = await directFetch('https://identitysso-cert.betfair.com/api/certlogin', {
    method: 'POST', cert: _cert, key: _key,
    headers: {
      'X-Application': appKey,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('Login non-JSON: ' + text.slice(0, 160)); }
  if (data.loginStatus !== 'SUCCESS') throw new Error('Login failed: ' + data.loginStatus);
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

let cachedSession = null; // { token, appKey, at }
const SESSION_TTL_MS = 3 * 60 * 60 * 1000;
async function getSession(appKey) {
  if (cachedSession && cachedSession.appKey === appKey && Date.now() - cachedSession.at < SESSION_TTL_MS) {
    return cachedSession.token;
  }
  const token = await login(appKey);
  cachedSession = { token, appKey, at: Date.now() };
  return token;
}

// Same liquidity-gated midpoint as betfair-f1.js — see its comment for why a bare back/lay
// average isn't trusted on thin exchange books.
const MIN_SIZE = 10;
const SOLO_MIN_SIZE = 50;
const MAX_SPREAD_PCT = 0.5;
function fairPrice(b, bSize, l, lSize) {
  const hasBack = b > 1 && bSize >= MIN_SIZE;
  const hasLay = l > 1 && lSize >= MIN_SIZE;
  if (hasBack && hasLay) {
    const mid = (b + l) / 2;
    if ((l - b) / mid <= MAX_SPREAD_PCT) return +mid.toFixed(3);
  }
  if (l > 1 && lSize >= SOLO_MIN_SIZE) return +l.toFixed(3);
  if (b > 1 && bSize >= SOLO_MIN_SIZE) return +b.toFixed(3);
  return null;
}

async function buildNflTd(appKey, session) {
  const now = new Date();
  const to = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  const catalogue = await bfCall('listMarketCatalogue', {
    filter: {
      eventTypeIds: [AMERICAN_FOOTBALL_EVENT_TYPE_ID],
      marketTypeCodes: ['TO_SCORE_A_TOUCHDOWN'],
      marketStartTime: { from: now.toISOString(), to: to.toISOString() },
    },
    marketProjection: ['EVENT', 'MARKET_START_TIME', 'RUNNER_DESCRIPTION'],
    sort: 'FIRST_TO_START',
    maxResults: 100,
  }, appKey, session);

  const events = [];
  // listMarketBook weight: EX_BEST_OFFERS is 5 per market, cap 200 — 20 per call is safe.
  for (let i = 0; i < (catalogue || []).length; i += 20) {
    const chunk = catalogue.slice(i, i + 20);
    const books = await bfCall('listMarketBook', {
      marketIds: chunk.map((m) => m.marketId),
      priceProjection: { priceData: ['EX_BEST_OFFERS'] },
    }, appKey, session);
    const bookById = {};
    for (const b of books || []) bookById[b.marketId] = b;
    for (const m of chunk) {
      const book = bookById[m.marketId];
      if (!book || book.status !== 'OPEN' || book.inplay) continue;
      const nameById = {};
      for (const r of m.runners || []) nameById[r.selectionId] = r.runnerName;
      const runners = [];
      for (const r of book.runners || []) {
        if (r.status !== 'ACTIVE') continue;
        const backLevel = r.ex && r.ex.availableToBack && r.ex.availableToBack[0];
        const layLevel = r.ex && r.ex.availableToLay && r.ex.availableToLay[0];
        const b = (backLevel && backLevel.price) || 0;
        const bSize = (backLevel && backLevel.size) || 0;
        const l = (layLevel && layLevel.price) || 0;
        const lSize = (layLevel && layLevel.size) || 0;
        runners.push({
          name: nameById[r.selectionId] || String(r.selectionId),
          fair: fairPrice(b, bSize, l, lSize),
          back: b > 1 ? b : null, backSize: Math.round(bSize * 100) / 100,
          lay: l > 1 ? l : null, laySize: Math.round(lSize * 100) / 100,
          traded: Math.round((r.totalMatched || 0) * 100) / 100,
        });
      }
      events.push({
        name: (m.event && m.event.name) || '', startTime: m.marketStartTime, marketId: m.marketId,
        traded: Math.round(book.totalMatched || 0), runners,
      });
    }
  }
  return { ok: true, events };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const appKey = process.env.BFEX_APP_KEY;
  if (!appKey) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'BFEX_APP_KEY not set' }) };
  try {
    let session = await getSession(appKey);
    let data;
    try {
      data = await buildNflTd(appKey, session);
    } catch (e) {
      if (String(e.message).includes('SESSION_EXPIRED')) {
        cachedSession = null;
        session = await getSession(appKey);
        data = await buildNflTd(appKey, session);
      } else throw e;
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

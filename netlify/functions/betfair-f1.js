// netlify/functions/betfair-f1.js
// Betfair Exchange Formula 1 fair prices, for the Bet Alerts F1 EW + Arbs feeds
// (oc-scraper/scripts/f1_scan.py fetches this from the DO server on localhost and combines
// it with the Oddschecker F1 scrape).
//
// Cert-based login reused from betfair.js / betfair-dogs.js — deliberately self-contained so
// nothing here can regress those live integrations. The cert only exists on the DO droplet,
// so this route only does anything real there; the read is lazy (inside the handler) so a
// missing cert returns { ok:false } instead of crashing server.js at boot.
//
// GET /api/betfair-f1  ->
//   { ok:true, race:{ name, startTime }, markets:{
//       winner:[{name,fair}], podium:[...], top6:[...], points:[...] } }
// where `fair` is the no-vig price between best back and best lay (2*b*l/(b+l)), or the one
// side that exists. Markets with no Betfair equivalent for the next race come back as [].
const https = require('https');
const fs = require('fs');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const BFEX_BASE = 'https://api.betfair.com/exchange/betting/rest/v1.0';
const MOTOR_SPORT_EVENT_TYPE_ID = '8'; // Betfair: 1=Soccer, 7=Horse Racing, 8=Motor Sport

// Betfair market names we care about -> our feed key. Matched case-insensitively as a
// substring so "Race Winner" / "Winner" both land on `winner`, etc.
const MARKET_MAP = [
  { key: 'winner', needles: ['race winner', 'winner'] },
  { key: 'podium', needles: ['podium finish', 'podium', 'top 3 finish'] },
  { key: 'top6',   needles: ['top 6 finish', 'top six finish', 'top 6'] },
  { key: 'points', needles: ['points finish', 'to finish in the points', 'top 10 finish'] },
];

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

function classifyMarket(name) {
  const n = String(name || '').toLowerCase();
  for (const m of MARKET_MAP) {
    if (m.needles.some((needle) => n.includes(needle))) return m.key;
  }
  return null;
}

// No-vig price between best back `b` and best lay `l`.
function fairPrice(b, l) {
  if (b > 1 && l > 1) return +((2 * b * l) / (b + l)).toFixed(3);
  if (b > 1) return +b.toFixed(3);
  if (l > 1) return +l.toFixed(3);
  return null;
}

async function buildF1(appKey, session) {
  const now = new Date();
  const to = new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000); // next 3 weeks
  const catalogue = await bfCall('listMarketCatalogue', {
    filter: {
      eventTypeIds: [MOTOR_SPORT_EVENT_TYPE_ID],
      marketStartTime: { from: now.toISOString(), to: to.toISOString() },
    },
    marketProjection: ['EVENT', 'COMPETITION', 'MARKET_START_TIME', 'RUNNER_DESCRIPTION'],
    sort: 'FIRST_TO_START',
    maxResults: 400,
  }, appKey, session);

  // Group markets by event; keep only F1 (Grand Prix / "Formula 1" competition) events that
  // actually have a Race Winner market, then take the soonest.
  const byEvent = {};
  for (const m of catalogue || []) {
    const evName = m.event && m.event.name ? m.event.name : '';
    const compName = (m.competition && m.competition.name) || '';
    const looksF1 = /grand prix|formula 1|f1\b|\bgp\b/i.test(evName) || /formula 1|f1\b/i.test(compName);
    if (!looksF1) continue;
    const cls = classifyMarket(m.marketName);
    if (!cls) continue;
    const id = m.event.id;
    (byEvent[id] = byEvent[id] || { name: evName, startTime: m.marketStartTime, markets: {} });
    byEvent[id].markets[cls] = { marketId: m.marketId, runners: m.runners || [] };
    if (new Date(m.marketStartTime) < new Date(byEvent[id].startTime)) byEvent[id].startTime = m.marketStartTime;
  }
  const events = Object.values(byEvent).filter((e) => e.markets.winner).sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  if (!events.length) {
    // help the next debugging pass see what the catalogue actually held
    const seenEvents = [...new Set((catalogue || []).map((m) => `${m.event && m.event.name}`))].slice(0, 15);
    const seenMarkets = [...new Set((catalogue || []).map((m) => m.marketName))].slice(0, 25);
    return { ok: true, race: null, markets: { winner: [], podium: [], top6: [], points: [] }, debug: { seenEvents, seenMarkets } };
  }
  const race = events[0];

  const wantKeys = ['winner', 'podium', 'top6', 'points'];
  const marketIds = wantKeys.filter((k) => race.markets[k]).map((k) => race.markets[k].marketId);
  const books = await bfCall('listMarketBook', {
    marketIds,
    priceProjection: { priceData: ['EX_BEST_OFFERS'] },
  }, appKey, session);
  const bookById = {};
  for (const b of books || []) bookById[b.marketId] = b;

  const out = { winner: [], podium: [], top6: [], points: [] };
  for (const k of wantKeys) {
    const mkt = race.markets[k];
    if (!mkt) continue;
    const book = bookById[mkt.marketId];
    if (!book) continue;
    const nameById = {};
    for (const r of mkt.runners) nameById[r.selectionId] = r.runnerName;
    for (const r of book.runners || []) {
      if (r.status !== 'ACTIVE') continue;
      const b = (r.ex && r.ex.availableToBack && r.ex.availableToBack[0] && r.ex.availableToBack[0].price) || 0;
      const l = (r.ex && r.ex.availableToLay && r.ex.availableToLay[0] && r.ex.availableToLay[0].price) || 0;
      const fair = fairPrice(b, l);
      if (!fair) continue;
      out[k].push({ name: nameById[r.selectionId] || String(r.selectionId), fair });
    }
  }
  return { ok: true, race: { name: race.name, startTime: race.startTime }, markets: out };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const appKey = process.env.BFEX_APP_KEY;
  if (!appKey) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'BFEX_APP_KEY not set' }) };
  try {
    let session = await getSession(appKey);
    let data;
    try {
      data = await buildF1(appKey, session);
    } catch (e) {
      if (String(e.message).includes('SESSION_EXPIRED')) {
        cachedSession = null;
        session = await getSession(appKey);
        data = await buildF1(appKey, session);
      } else throw e;
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

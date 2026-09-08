// skybet-bfex-lib.js — SkyBet football fixtures for the next 5 days (with SkyBet back odds),
// each annotated with Betfair Exchange MATCH_ODDS lay prices + liquidity. Backend only —
// feeds the acca-freeze builder; not rendered anywhere yet.
//
// Runs on the DO box (required directly by server.js), NOT as a Netlify function:
//   - the SkyBet side reuses skybet-accafreeze-lib.js, which is DO-only (geo-fence)
//   - the Betfair side needs the cert-login (client-2048.crt/.key live on /root, DO-only)
//
// SkyBet fixtures: the skybet-accafreeze feed's `fixtures` array is every fixture where Acca
// Freeze is offered — i.e. essentially all SkyBet football — and every one carries home/draw/
// away FTR (back) odds. ~190 fixtures over today+5d. So no separate all-football scrape is
// needed; we just reuse that handler's output.
//
// Betfair: one listMarketCatalogue(MATCH_ODDS, marketStartTime = now..now+5d) → ~500 markets,
// then listMarketBook in chunks for EX_BEST_OFFERS lay prices + per-runner/market totalMatched.
// Login / bfCall are copied from netlify/functions/betfair.js (kept in sync by hand).

const https = require('https');
const fs = require('fs');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const BFEX_BASE = 'https://api.betfair.com/exchange/betting/rest/v1.0';
const DRAW_SELECTION_ID = 58805; // Betfair's fixed "The Draw" selectionId across all football
const WINDOW_DAYS = 5;
const BOOK_CHUNK = 40;

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

// ── Name matching (SkyBet names vs Betfair names) ────────────────────────────
function norm(n) {
  return (n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\butd\b/g, 'united').replace(/\bnottm\b/g, 'nottingham')
    .replace(/\bwolves\b/g, 'wolverhampton').replace(/\bspurs\b/g, 'tottenham')
    .replace(/\bmunich\b/g, 'munchen') // Betfair "Munich" ↔ SkyBet "München"→"munchen"
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

  // Resolve each market's home/away/draw from runner order + the "X v Y" event name.
  return Object.values(byMarket).map(m => {
    const parts = m.eventName.split(/\s+v\s+/i);
    const evHome = parts[0], evAway = parts[1];
    let homeR = null, awayR = null, drawR = null;
    for (const r of m.runners) {
      if (r.selectionId === DRAW_SELECTION_ID || /^the draw$/i.test(r.name)) { drawR = r; continue; }
      if (evHome && teamEq(r.name, evHome)) homeR = r;
      else if (evAway && teamEq(r.name, evAway)) awayR = r;
    }
    // fall back to sortPriority (1 home, 2 away) if name match failed
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

// ── Join ────────────────────────────────────────────────────────────────────
function findBfex(skyFx, bfexList) {
  const skt = skyFx.kickoff ? Date.parse(skyFx.kickoff) : null;
  let best = null, bestDelta = Infinity;
  for (const b of bfexList) {
    if (!(teamEq(skyFx.home, b.home) && teamEq(skyFx.away, b.away))) continue;
    const bt = b.startTime ? Date.parse(b.startTime) : null;
    const delta = (skt && bt) ? Math.abs(skt - bt) : 0;
    if (delta < bestDelta) { best = b; bestDelta = delta; }
  }
  if (best && skt && best.startTime && bestDelta > 6 * 3600e3) return null; // >6h apart → different fixture
  return best;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const appKey = process.env.BFEX_APP_KEY;
  if (!appKey) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'BFEX_APP_KEY not set' }) };

  try {
    // 1. SkyBet fixtures + back odds (reuse the accafreeze scraper's fixtures list)
    const skyRes = await require('./skybet-accafreeze-lib').handler({ httpMethod: 'GET', queryStringParameters: {} });
    const sky = JSON.parse(skyRes.body);
    if (!sky.ok) throw new Error('skybet-accafreeze: ' + (sky.error || 'failed'));

    // 2. Betfair MATCH_ODDS lay odds for the same window
    const session = await getSessionToken();
    const bfexList = await fetchBfexMatchOdds(appKey, session);

    // 3. Join
    let matched = 0;
    const fixtures = (sky.fixtures || []).map(f => {
      const b = findBfex(f, bfexList);
      if (b) matched++;
      return {
        eventId: f.eventId,
        home: f.home,
        away: f.away,
        kickoff: f.kickoff,
        competition: f.competition,
        skyOdds: { home: f.homeOdds ?? null, draw: f.drawOdds ?? null, away: f.awayOdds ?? null },
        accaFreezeEligible: !!f.accaFreezeEligible,
        skyUrl: f.url || null,
        bfex: b ? {
          marketId: b.marketId,
          eventId: b.eventId,
          status: b.status,
          totalMatched: b.totalMatched,
          lay: b.lay,
        } : null,
      };
    }).sort((a, c) => (a.kickoff || '').localeCompare(c.kickoff || ''));

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: true,
        updated: new Date().toISOString(),
        windowDays: WINDOW_DAYS,
        count: fixtures.length,
        bfexMarkets: bfexList.length,
        matchedToBfex: matched,
        fixtures,
      }),
    };
  } catch (err) {
    const expired = err.message === 'SESSION_EXPIRED';
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message, sessionExpired: expired }) };
  }
};

// bb-bet-tracker.js — BookieBashing's Trackers → Bet Tracker, copied as-is (2026-10-03) for the
// Calculations → BB Bet Tracker page. Same BB_COOKIES auth as bb-odds.js / bb-lead.js.
//
// BB's tracker is a jQuery app (/app/bet/js/bet.js) with no plain JSON endpoint: every read goes
// through POST /app/auth.php with { auth: {user_key, session_token, hash}, requests: [...] }.
// The auth trio comes from `var session_data = '{...}'` embedded in the logged-in tracker page,
// so each call fetches that page first. Requests mirror bet.js selection_requests() for a
// public + private user (BB's own filters: active, EV ratio > 0.8, KO in the next 18h, plus
// "early" bets with no KO cap; private = bets credited to this user) and intLoad()'s bookList.
//
// Gotcha: bet.js sends the body as "data=" + JSON.stringify(...) WITHOUT URL-encoding, and the
// filters carry literal "%26" that BB decodes to "&". encodeURIComponent'ing the body double-
// encodes those and BB silently returns empty selections.

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE = 'https://www.bookiebashing.net';

function parseMaybeJson(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}

async function loadBets(cookies) {
  const headers = { 'User-Agent': UA, Cookie: cookies, Referer: `${BASE}/trackers/bet-tracker/`, Origin: BASE };
  const html = await (await fetch(`${BASE}/trackers/bet-tracker/`, { headers })).text();
  const sdm = html.match(/var session_data = '(.*?)';/);
  if (!sdm) throw new Error('BB tracker page has no session_data — BB_COOKIES probably expired');
  const sd = JSON.parse(sdm[1]);
  const um = html.match(/rest_user = '\{\\?"id\\?":(\d+)/);
  const uid = um ? um[1] : null;

  const now = Math.floor(Date.now() / 1000), in18h = now + 64800;
  const pub = (n) => `filter${n}=status,eq,1%26filter${n}=is_private,eq,0%26filter${n}=is_group,eq,0%26filter${n}=ev,gt,0.8%26filter${n}=ko_time,gt,${now}`;
  const requests = [
    { data_name: 'bookList', method: 'getCachedData', dataname: 'bookList' },
    { data_name: 'selections', method: 'restGet', tab: 'bets', system: 'bet',
      filters: `${pub(1)}%26filter1=ko_time,lt,${in18h}%26${pub(2)}%26filter2=is_early,eq,1%26exclude=bet_info,calc_data` },
  ];
  if (uid) requests.push({ data_name: 'selections_private', method: 'restGet', tab: 'bets', system: 'bet',
    filters: `filter3=is_private,eq,1%26filter3=status,eq,1%26filter3=credit,eq,${uid}%26filter3=ko_time,gt,${now}%26exclude=bet_info,calc_data` });

  const body = 'data=' + JSON.stringify({ auth: { user_key: sd.key, session_token: sd.token, hash: sd.hash }, requests });
  const r = await fetch(`${BASE}/app/auth.php`, {
    method: 'POST', body,
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
  });
  const d = await r.json();
  if (d.fcode > 0) throw new Error(d.message || `BB auth error ${d.fcode}`);

  // bookList comes back as {id: {...}} or [{id, name...}] depending on BB's cache — handle both.
  const bl = parseMaybeJson(d.bookList) || {};
  const books = {};
  for (const b of (Array.isArray(bl) ? bl : Object.values(bl))) {
    if (b && b.id != null) books[String(b.id)] = b.name || b.title || b.bookie || String(b.id);
  }
  const recs = (key) => ((parseMaybeJson(d[key]) || {}).records || []);
  const seen = new Set();
  const bets = [];
  for (const [key, isPrivate] of [['selections', false], ['selections_private', true]]) {
    for (const s of recs(key)) {
      if (!s || seen.has(s.id)) continue;
      seen.add(s.id);
      const name = String(s.name || '');
      const cut = name.indexOf(' - ');
      const odds = parseFloat(s.bet_odds), fair = parseFloat(s.fair_odds);
      bets.push({
        id: s.id,
        name,
        event: cut > 0 ? name.slice(0, cut) : '',
        selection: cut > 0 ? name.slice(cut + 3) : name,
        bookie: books[String(s.bookid)] || `Book ${s.bookid}`,
        bookId: s.bookid,
        odds: isFinite(odds) ? odds : null,
        fair: isFinite(fair) ? fair : null,
        ev: s.ev != null ? +((s.ev - 1) * 100).toFixed(2) : null,   // BB stores odds/fair as a ratio
        ko: s.ko_time ? new Date(s.ko_time * 1000).toISOString() : null,
        credit: s.credit || null,
        early: !!s.is_early, combo: !!s.is_combo, lay: !!s.is_lay, private: isPrivate,
        added: s.added || null, updated: s.updated || null,
      });
    }
  }
  bets.sort((a, b) => (b.ev ?? -1e9) - (a.ev ?? -1e9));
  return { bets, bookCount: Object.keys(books).length };
}

// ---- Bet Alerts tab extras (2026-11-25) ----
const BFEX_CHECK_FILE = require('path').join(__dirname, '..', '..', 'oc-scraper', 'data', 'bb_tracker_bfex.json');
const PU_FRESH_MS = 20 * 60 * 1000;
const normSel = t => String(t || '').toLowerCase().replace(/[^a-z0-9.]/g, '');

async function fetchPricedUpBoosts() {
  const key = process.env.LEDGER_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(`http://localhost:${process.env.PORT || 3000}/api/ledger/pricedup-boosts`, { headers: { 'x-ledger-key': key } });
    const d = await r.json();
    return d && d.ok && Array.isArray(d.rows) ? d.rows : null;
  } catch (e) { return null; }
}

async function reconcileBets(bets) {
  const info = { bfexChecked: 0, puRemoved: 0, puAdjusted: 0, puSkipped: null };
  // 1) BFEX check marker (written by oc-scraper/scripts/bb_tracker_bfex_check.py every pipeline run).
  let marks = {};
  try { marks = JSON.parse(require('fs').readFileSync(BFEX_CHECK_FILE, 'utf8')).rows || {}; } catch (e) {}
  for (const b of bets) {
    const m = marks[String(b.id)];
    if (m && m.fair) { b.bfexFair = m.fair; b.bfexMkt = m.mkt || null; b.bfexLow = !!m.lowBfex; info.bfexChecked++; }
  }
  // 2) PricedUp: BB's rows can be stale (boost pulled / price moved). Our own scrape of PricedUp is the truth.
  const rows = await fetchPricedUpBoosts();
  const newest = rows && rows.length ? Math.max(...rows.map(r => Date.parse(r.scraped_at) || 0)) : 0;
  if (!rows || !rows.length || Date.now() - newest > PU_FRESH_MS) {
    info.puSkipped = !rows ? 'PricedUp scrape unavailable' : (!rows.length ? 'no PricedUp boosts scraped' : 'PricedUp scrape is stale');
    return { bets, info };
  }
  const bySel = new Map();
  for (const r of rows) { const k = normSel(r.selection); if (!bySel.has(k)) bySel.set(k, []); bySel.get(k).push(r); }
  const out = [];
  for (const b of bets) {
    if (b.bookie !== 'PricedUp' || b.lay) { out.push(b); continue; }
    const cands = bySel.get(normSel(b.selection || b.name));
    if (!cands) { info.puRemoved++; continue; }                       // boost no longer on PricedUp
    const live = cands.reduce((best, r) => (!best || Math.abs(r.odds - b.odds) < Math.abs(best.odds - b.odds)) ? r : best, null);
    const odds = Math.round(Number(live.odds) * 100) / 100;
    if (Math.abs(odds - b.odds) > 0.005) {
      if (b.fair) { b.oddsBB = b.odds; b.odds = odds; b.ev = Math.round((odds / b.fair - 1) * 10000) / 100; info.puAdjusted++; }
    }
    if (b.fair && b.ev != null && b.ev <= 0) { info.puRemoved++; continue; } // no longer value at our scraped price
    out.push(b);
  }
  return { bets: out, info };
}

exports.handler = async (event) => {
  if (event && event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // 2026-11-25: BB login now auto-refreshes on the DO box (bb-auth.js sets BB_AUTH_LOCAL there). Anywhere else
  // (Netlify) proxy to the box instead of using stale BB_COOKIES/BB_HASH env vars.
  if (!process.env.BB_AUTH_LOCAL) {
    try {
      const qs = event.rawQuery || new URLSearchParams(event.queryStringParameters || {}).toString();
      const r = await fetch(`http://${process.env.LEDGER_DO_HOST || '178.128.40.248'}:${process.env.LEDGER_DO_PORT || 3000}/api/bb-bet-tracker${qs ? '?' + qs : ''}`);
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: await r.text() };
    } catch (e) {
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'DO server unreachable: ' + e.message }) };
    }
  }
  const cookies = process.env.BB_COOKIES;
  if (!cookies) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'BB_COOKIES not set' }) };
  try {
    let { bets, bookCount } = await loadBets(cookies);
    // ?reconcile=1 (Bet Alerts → BB Tracker tab only; the Calculations page stays a straight copy):
    // attach our own BFEX fair marker and reconcile BB's PricedUp rows against the boosts we scrape ourselves.
    let reconciled = null;
    const qp = (event && event.queryStringParameters) || {};
    if (qp.reconcile === '1' || qp.reconcile === 'true') {
      const r = await reconcileBets(bets);
      bets = r.bets; reconciled = r.info;
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, updated: new Date().toISOString(), count: bets.length, bookCount, reconciled, bets }) };
  } catch (e) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

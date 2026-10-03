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

exports.handler = async (event) => {
  if (event && event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const cookies = process.env.BB_COOKIES;
  if (!cookies) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'BB_COOKIES not set' }) };
  try {
    const { bets, bookCount } = await loadBets(cookies);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, updated: new Date().toISOString(), count: bets.length, bookCount, bets }) };
  } catch (e) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

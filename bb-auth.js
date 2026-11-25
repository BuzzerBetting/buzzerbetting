// bb-auth.js — keeps BookieBashing credentials fresh automatically (2026-11-25).
// BB is WordPress (xoo-el login plugin): POST admin-ajax.php action=xoo_el_form_action logs in and sets
// the wordpress_logged_in_* / wordpress_sec_* cookies; the node/rest API's X-BB-Hash is the "hash"
// inside `var session_data = '{...}'` on any logged-in page.
//   - Login (user/pass) lives ONLY on the box in data/bb_login.json (gitignored, chmod 600).
//   - startBbAuth() logs in at boot and every REFRESH_MS, writes data/bb_auth.json {cookies,hash,userId,at}
//     and sets process.env.BB_COOKIES / BB_HASH, so bb-odds / bb-lead / ddhh / bb-bet-tracker (all read env
//     per request) pick the new values up without a restart. oc-scraper scripts (bb_snapshot.js,
//     darts_bb_fair_scan.py) read data/bb_auth.json first, then fall back to the pm2 env.
//   - Never retries faster than MIN_GAP_MS (a failing login must not hammer BB — see oc-cloudflare-block).
const fs = require('fs');
const path = require('path');

const BASE = 'https://www.bookiebashing.net';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LOGIN_FILE = path.join(__dirname, 'data', 'bb_login.json');
const AUTH_FILE = path.join(__dirname, 'data', 'bb_auth.json');
const REFRESH_MS = 2 * 3600e3;
const MIN_GAP_MS = 10 * 60e3;

process.env.BB_AUTH_LOCAL = '1'; // marks this process as the box that owns the BB login
let lastAttempt = 0, inflight = null, timer = null;
const state = { ok: null, at: null, error: null };

function parseSetCookies(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    if (i < 1) continue;
    const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
    if (/^(deleted|)$/.test(v) || /expires=Thu, 01 Jan 1970/i.test(c)) delete jar[k]; else jar[k] = v;
  }
}
const cookieHeader = jar => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

async function doLogin() {
  let creds;
  try { creds = JSON.parse(fs.readFileSync(LOGIN_FILE, 'utf8')); } catch (e) { throw new Error('data/bb_login.json missing'); }
  const jar = {};
  const r0 = await fetch(`${BASE}/login/`, { headers: { 'User-Agent': UA }, redirect: 'manual' });
  parseSetCookies(r0, jar);
  const body = new URLSearchParams({
    _xoo_el_form: 'login', xoo_el_redirect: '/login/', 'xoo-el-username': creds.user, 'xoo-el-password': creds.pass,
    'xoo-el-rememberme': 'forever', action: 'xoo_el_form_action',
  });
  const r1 = await fetch(`${BASE}/wp-admin/admin-ajax.php`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest',
      Referer: `${BASE}/login/`, Cookie: cookieHeader(jar) },
    body,
  });
  parseSetCookies(r1, jar);
  const j = await r1.json().catch(() => null);
  if (!j || j.error !== 0 || !Object.keys(jar).some(k => k.startsWith('wordpress_logged_in_'))) {
    throw new Error('BB login failed: ' + (j ? String(j.notice || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : 'no JSON'));
  }
  const cookies = cookieHeader(jar);
  const page = await (await fetch(`${BASE}/`, { headers: { 'User-Agent': UA, Cookie: cookies } })).text();
  const m = page.match(/var session_data = '(.*?)';/);
  if (!m) throw new Error('BB logged-in page has no session_data');
  const sd = JSON.parse(m[1]);
  if (!sd.hash) throw new Error('BB session_data has no hash');
  return { cookies, hash: sd.hash, userId: sd.user_id || null, at: new Date().toISOString() };
}

// Log in now (rate-limited unless force). Resolves {ok, error?}.
function refreshBbAuth({ force = false } = {}) {
  if (inflight) return inflight;
  if (!force && Date.now() - lastAttempt < MIN_GAP_MS) return Promise.resolve({ ok: state.ok, error: 'rate-limited' });
  lastAttempt = Date.now();
  inflight = (async () => {
    try {
      const a = await doLogin();
      try { fs.writeFileSync(AUTH_FILE, JSON.stringify(a), { mode: 0o600 }); } catch (e) {}
      process.env.BB_COOKIES = a.cookies;
      process.env.BB_HASH = a.hash;
      Object.assign(state, { ok: true, at: a.at, error: null });
      console.log('[bb-auth] logged in, hash ' + a.hash.slice(0, 8) + '…');
      return { ok: true };
    } catch (e) {
      Object.assign(state, { ok: false, error: e.message });
      console.error('[bb-auth] ' + e.message);
      return { ok: false, error: e.message };
    } finally { inflight = null; }
  })();
  return inflight;
}

function startBbAuth() {
  if (timer) return;
  // At boot prefer a still-fresh saved login (avoids a re-login on every pm2 restart loop).
  try {
    const a = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (a && a.cookies && a.hash && Date.now() - Date.parse(a.at) < REFRESH_MS) {
      process.env.BB_COOKIES = a.cookies; process.env.BB_HASH = a.hash;
      Object.assign(state, { ok: true, at: a.at, error: null });
    } else refreshBbAuth({ force: true });
  } catch (e) { refreshBbAuth({ force: true }); }
  timer = setInterval(() => { refreshBbAuth({ force: true }); }, REFRESH_MS);
  timer.unref && timer.unref();
}

module.exports = { startBbAuth, refreshBbAuth, bbAuthState: () => ({ ...state }) };

export const handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const { matchId } = event.queryStringParameters || {};
  if (!matchId) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'matchId required' }) };

  const email    = process.env.BB_EMAIL;
  const password = process.env.BB_PASSWORD;
  if (!email || !password) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'BB credentials not set in Netlify env vars' }) };

  const BB_NODE = 'https://www.bookiebashing.net/node';
  const BB_WP   = 'https://www.bookiebashing.net';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  function extractCookies(res) {
    if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
    const raw = res.headers.get('set-cookie');
    if (!raw) return [];
    return raw.split(/,(?=\s*\w+=)/);
  }
  function parseCookieJar(lines) {
    const jar = {};
    for (const line of lines) {
      const part = line.split(';')[0].trim();
      const eq = part.indexOf('=');
      if (eq < 1) continue;
      jar[part.substring(0, eq).trim()] = part.substring(eq + 1).trim();
    }
    return jar;
  }
  function jarToHeader(jar) {
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async function safeFetch(url, opts) {
    const res = await fetch(url, opts);
    const text = await res.text();
    const isHTML = text.trim().startsWith('<');
    return { res, text, isHTML, status: res.status };
  }

  try {
    const jar = {};

    // ── Step 1: WordPress login ──────────────────────────────────────────────
    const { res: loginRes } = await safeFetch(`${BB_WP}/wp-login.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        'Cookie': 'wordpress_test_cookie=WP+Cookie+check'
      },
      body: new URLSearchParams({
        log: email, pwd: password,
        'wp-submit': 'Log In',
        redirect_to: '/tools/daily/',
        testcookie: '1'
      }),
      redirect: 'manual'
    });
    Object.assign(jar, parseCookieJar(extractCookies(loginRes)));

    const wpLoggedIn = Object.keys(jar).some(k => k.startsWith('wordpress_logged_in'));
    if (!wpLoggedIn) return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: false, error: 'WordPress login failed — check BB_EMAIL / BB_PASSWORD env vars',
      cookies_received: Object.keys(jar)
    })};

    // ── Step 2: BB node authenticate ─────────────────────────────────────────
    const { res: authRes, text: authText, isHTML: authHTML } = await safeFetch(`${BB_NODE}/authenticate`, {
      headers: { 'User-Agent': UA, 'Cookie': jarToHeader(jar) }
    });
    Object.assign(jar, parseCookieJar(extractCookies(authRes)));
    if (authHTML) return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: false, error: 'authenticate returned HTML', preview: authText.substring(0, 300)
    })};
    const authBody = JSON.parse(authText);
    if (!authBody.authenticated) return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: false, error: 'BB node auth returned authenticated:false', authBody
    })};

    // ── Step 3: auth.php — get session hash ──────────────────────────────────
    const { res: authPhpRes, text: authPhpText, isHTML: authPhpHTML } = await safeFetch(`${BB_WP}/node/rest/auth.php`, {
      headers: { 'User-Agent': UA, 'Cookie': jarToHeader(jar) }
    });
    Object.assign(jar, parseCookieJar(extractCookies(authPhpRes)));
    if (authPhpHTML) return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: false, error: 'auth.php returned HTML — session not carried over',
      preview: authPhpText.substring(0, 300), cookies: Object.keys(jar)
    })};
    const authPhpData = JSON.parse(authPhpText);

    const rawSessions = authPhpData?.user_data?.sessions;
    if (!rawSessions) return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: false, error: 'No sessions found in auth.php response',
      keys: authPhpData ? Object.keys(authPhpData) : []
    })};

    const sessions = typeof rawSessions === 'string' ? JSON.parse(rawSessions) : rawSessions;
    const sessionList = Object.values(sessions).sort((a, b) => (b.changed || 0) - (a.changed || 0));
    if (!sessionList.length) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'sessions object empty' })};

    const bbHash   = sessionList[0].hash;
    const bbUserId = authPhpData?.user_data?.wp_user_id || 11815;

    // ── Step 4: Fetch goals/list ─────────────────────────────────────────────
    const ts = Math.floor(Date.now() / 1000);
    const { res: listRes, text: listText, isHTML: listHTML } = await safeFetch(`${BB_NODE}/rest/goals/list?t=${ts}`, {
      headers: {
        'User-Agent': UA,
        'Cookie': jarToHeader(jar),
        'X-BB-User': 'user',
        'X-BB-Hash': bbHash,
        'X-BB-Userid': String(bbUserId),
        'X-BB-Userlevel': '1',
        'Referer': 'https://www.bookiebashing.net/tools/daily/',
        'Origin': 'https://www.bookiebashing.net'
      }
    });

    if (listHTML || !listRes.ok) return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: false, error: `List endpoint returned ${listRes.status} — auth header may be wrong`,
      hash_used: bbHash,
      response_preview: listText.substring(0, 300)
    })};

    const listData = JSON.parse(listText);
    const matches = Array.isArray(listData) ? listData : [listData];
    const match = matches.find(m =>
      String(m.eventId) === String(matchId) ||
      String(m._id)     === String(matchId)
    );

    if (!match) return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: false, error: `Match ${matchId} not found in BB list`,
      total_matches: matches.length,
      sample_keys: matches[0] ? Object.keys(matches[0]) : [],
      sample_events: matches.slice(0, 5).map(m => ({ id: m._id, eventId: m.eventId, event: m.event }))
    })};

    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: true, matchId, event: match.event, raw: match
    })};

  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message, stack: err.stack })};
  }
};

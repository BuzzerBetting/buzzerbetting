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
  if (!email || !password) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'BB credentials not set' }) };

  const BB   = 'https://www.bookiebashing.net';
  const NODE = BB + '/node';
  const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  // ── helpers ────────────────────────────────────────────────────────────────
  function extractCookies(res) {
    if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
    const raw = res.headers.get('set-cookie');
    if (!raw) return [];
    return raw.split(/,(?=\s*\w+=)/);
  }
  function mergeCookies(jar, res) {
    for (const line of extractCookies(res)) {
      const part = line.split(';')[0].trim();
      const eq = part.indexOf('=');
      if (eq < 1) continue;
      jar[part.substring(0, eq).trim()] = part.substring(eq + 1).trim();
    }
  }
  function cookieHeader(jar) {
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async function get(url, jar) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Cookie': cookieHeader(jar), 'Referer': BB + '/' } });
    mergeCookies(jar, res);
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, json: () => JSON.parse(text), isHTML: text.trim().startsWith('<') };
  }
  async function post(url, jar, body, isJSON) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Cookie': cookieHeader(jar),
        'Referer': BB + '/',
        'Content-Type': isJSON ? 'application/json' : 'application/x-www-form-urlencoded'
      },
      body: isJSON ? JSON.stringify(body) : new URLSearchParams(body),
      redirect: 'manual'
    });
    mergeCookies(jar, res);
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, json: () => JSON.parse(text), isHTML: text.trim().startsWith('<') };
  }

  try {
    const jar = {};

    // ── 1. WordPress login ─────────────────────────────────────────────────
    await post(`${BB}/wp-login.php`, jar, {
      log: email, pwd: password,
      'wp-submit': 'Log In',
      redirect_to: '/tools/daily/',
      testcookie: '1'
    }, false);

    const wpOk = Object.keys(jar).some(k => k.startsWith('wordpress_logged_in'));
    if (!wpOk) return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: false, error: 'WordPress login failed', cookies: Object.keys(jar)
    })};

    // ── 2. First authenticate (gets basic session) ─────────────────────────
    const auth1 = await get(`${NODE}/authenticate`, jar);
    if (auth1.isHTML) return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: false, error: 'authenticate(1) returned HTML', preview: auth1.text.substring(0, 200)
    })};

    // ── 3. Second authenticate (gets session token UUID) ───────────────────
    const auth2 = await get(`${NODE}/authenticate`, jar);
    if (auth2.isHTML) return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: false, error: 'authenticate(2) returned HTML'
    })};

    const auth2Data = auth2.json();
    // authenticated field is either true or a UUID session token
    const sessionToken = typeof auth2Data.authenticated === 'string'
      ? auth2Data.authenticated
      : null;

    // ── 4. Get hash from sessions via auth.php POST ────────────────────────
    // We use the user_key from env (stored as BB_USER_KEY) or fall back to
    // getting it from auth.php with minimal payload first
    const userKey = process.env.BB_USER_KEY || '12158b6f24adf0866c6a979c196985694f538983cca9f656455479a46215d90d';
    const userId  = process.env.BB_USER_ID  || '3020';
    const wpUserId = process.env.BB_WP_USER_ID || '11815';
    const ts = Math.floor(Date.now() / 1000);

    // Build the auth.php POST payload — same format we saw in the Network tab
    const authPayload = {
      auth: {
        user_key: userKey,
        session_token: sessionToken || '',
        hash: '' // empty hash on first call — server may still respond
      },
      requests: [{
        data_name: 'user_request_add',
        method: 'restCreate',
        tab: 'user_requests',
        data: JSON.stringify({ user_id: parseInt(userId), software: 'player-stats', created: String(ts) }),
        system: 'user'
      }]
    };

    const authPhp = await post(`${BB}/app/auth.php`, jar, authPayload, true);
    if (authPhp.isHTML) return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: false, error: 'auth.php returned HTML', cookies: Object.keys(jar), preview: authPhp.text.substring(0,200)
    })};

    let bbHash = null;
    try {
      const authPhpData = authPhp.json();
      // Response may contain updated session with hash, or sessions list
      const rawSessions = authPhpData?.user_data?.sessions;
      if (rawSessions) {
        const sessions = typeof rawSessions === 'string' ? JSON.parse(rawSessions) : rawSessions;
        const list = Object.values(sessions).sort((a, b) => (b.changed || 0) - (a.changed || 0));
        if (list.length) bbHash = list[0].hash;
      }
    } catch(e) {}

    // ── 5. If we still have no hash, try getting it from the node sessions ──
    // Fall back: call the node config endpoint which may echo back the hash
    if (!bbHash && sessionToken) {
      const cfg = await get(`${NODE}/rest/config?t=${ts}&userId=${wpUserId}&newUserId=${userId}`, jar);
      if (!cfg.isHTML) {
        try {
          const cfgData = cfg.json();
          bbHash = cfgData?.hash || cfgData?.apiHash || null;
        } catch(e) {}
      }
    }

    if (!bbHash) return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: false,
      error: 'Could not obtain BB hash',
      session_token: sessionToken,
      auth_php_preview: authPhp.text.substring(0, 500)
    })};

    // ── 6. Call the list endpoint ──────────────────────────────────────────
    const listTs = Math.floor(Date.now() / 1000);
    const listRes = await fetch(`${NODE}/rest/goals/list?t=${listTs}`, {
      headers: {
        'User-Agent': UA,
        'Cookie': cookieHeader(jar),
        'X-BB-User': 'user',
        'X-BB-Hash': bbHash,
        'X-BB-Userid': wpUserId,
        'X-BB-Userlevel': '1',
        'Referer': BB + '/tools/daily/',
        'Origin': BB
      }
    });
    mergeCookies(jar, listRes);
    const listText = await listRes.text();

    if (listText.trim().startsWith('<')) return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: false, error: `List returned HTML — hash may be wrong`, hash: bbHash, preview: listText.substring(0, 300)
    })};

    const listData = JSON.parse(listText);
    const matches = Array.isArray(listData) ? listData : [listData];
    const match = matches.find(m =>
      String(m.eventId) === String(matchId) ||
      String(m._id)     === String(matchId)
    );

    if (!match) return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: false,
      error: `Match ${matchId} not found`,
      total_matches: matches.length,
      sample_events: matches.slice(0, 5).map(m => ({ id: m._id, eventId: m.eventId, event: m.event }))
    })};

    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: true, matchId, event: match.event, raw: match
    })};

  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: false, error: err.message, stack: err.stack
    })};
  }
};

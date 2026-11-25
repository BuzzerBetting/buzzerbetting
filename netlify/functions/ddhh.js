const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // 2026-11-25: BB login now auto-refreshes on the DO box (bb-auth.js sets BB_AUTH_LOCAL there). Anywhere else
  // (Netlify) proxy to the box instead of using stale BB_COOKIES/BB_HASH env vars.
  if (!process.env.BB_AUTH_LOCAL) {
    try {
      const qs = event.rawQuery || new URLSearchParams(event.queryStringParameters || {}).toString();
      const r = await fetch(`http://${process.env.LEDGER_DO_HOST || '178.128.40.248'}:${process.env.LEDGER_DO_PORT || 3000}/api/ddhh${qs ? '?' + qs : ''}`);
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: await r.text() };
    } catch (e) {
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'DO server unreachable: ' + e.message }) };
    }
  }

  const hash    = process.env.BB_HASH;
  const cookies = process.env.BB_COOKIES;
  if (!hash || !cookies) return {
    statusCode: 200, headers: CORS,
    body: JSON.stringify({ ok: false, error: 'BB_HASH or BB_COOKIES not set' })
  };

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  try {
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(`https://www.bookiebashing.net/node/rest/goals/list?t=${ts}`, {
      headers: {
        'User-Agent': UA,
        'Cookie': cookies,
        'X-BB-Hash': hash,
        'X-BB-User': 'user',
        'X-BB-Userid': '11815',
        'X-BB-Userlevel': '1',
        'Referer': 'https://www.bookiebashing.net/tools/daily/',
        'Origin': 'https://www.bookiebashing.net'
      }
    });

    const text = await res.text();
    if (text.trim().startsWith('<')) return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: false, error: 'BB returned HTML — credentials may have expired' })
    };

    const list = JSON.parse(text);

    const eligible = list
      .filter(m => m.isDdHh || m.isInPlayDdHh)
      .map(m => ({
        eventId:     m.eventId || m.id || m._id,
        event:       m.event || m.name || m.eventName || '',
        competition: m.competition?.name || '',
        startTime:   m.startTime || null,
        pregame:     !!m.isDdHh,
        inplay:      !!m.isInPlayDdHh,
      }))
      .sort((a, b) => (a.startTime || 0) - (b.startTime || 0));

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: true, count: eligible.length, matches: eligible })
    };

  } catch (err) {
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};

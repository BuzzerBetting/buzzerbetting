export const handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const { player } = event.queryStringParameters || {};
  if (!player) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'player name required' }) };

  const hash    = process.env.BB_HASH;
  const cookies = process.env.BB_COOKIES;
  if (!hash || !cookies) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'BB_HASH or BB_COOKIES env vars not set' }) };

  try {
    const url = `https://www.bookiebashing.net/node/rest/goals/list/player-stat-history?player=${encodeURIComponent(player)}`;
    
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
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
    if (text.trim().startsWith('<')) return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: false, error: 'BB returned HTML — hash or cookies may have expired', status: res.status
    })};

    const data = JSON.parse(text);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, data }) };

  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

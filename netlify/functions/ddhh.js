const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const hash    = process.env.BB_HASH;
  const cookies = process.env.BB_COOKIES;
  if (!hash || !cookies) return {
    statusCode: 200, headers: CORS,
    body: JSON.stringify({ ok: false, error: 'BB_HASH or BB_COOKIES not set' })
  };

  const { date } = event.queryStringParameters || {};

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

    // Determine target date — default to today in UK time
    const now = new Date();
    const ukNow = new Date(now.toLocaleString('en-GB', { timeZone: 'Europe/London' }));
    const targetDate = date || `${ukNow.getFullYear()}-${String(ukNow.getMonth()+1).padStart(2,'0')}-${String(ukNow.getDate()).padStart(2,'0')}`;

    // Filter to DDHH eligible matches on the target date
    const eligible = list
      .filter(m => {
        if (!m.isDdHh && !m.isInPlayDdHh) return false;
        if (!m.startTime) return false;
        const d = new Date(m.startTime);
        const ukD = new Date(d.toLocaleString('en-GB', { timeZone: 'Europe/London' }));
        const matchDate = `${ukD.getFullYear()}-${String(ukD.getMonth()+1).padStart(2,'0')}-${String(ukD.getDate()).padStart(2,'0')}`;
        return matchDate === targetDate;
      })
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
      body: JSON.stringify({ ok: true, count: eligible.length, date: targetDate, matches: eligible })
    };

  } catch (err) {
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};

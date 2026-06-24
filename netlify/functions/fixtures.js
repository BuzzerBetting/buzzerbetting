const LEAGUE_IDS = new Set([
  77,   // FIFA World Cup 2026
  47,   // Premier League
  48,   // Championship
  87,   // La Liga
  54,   // Bundesliga
  55,   // Serie A
  53,   // Ligue 1
  42,   // UEFA Champions League
  73,   // UEFA Europa League
  40,   // FA Cup
  10160 // UEFA Conference League
]);

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Referer': 'https://www.fotmob.com/',
  'Origin': 'https://www.fotmob.com'
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const date = event.queryStringParameters?.date || todayStr();

  try {
    const url = `https://www.fotmob.com/api/matches?date=${date}`;
    const res = await fetch(url, { headers: HEADERS });

    if (!res.ok) {
      return respond(false, { error: `FotMob returned HTTP ${res.status}` });
    }

    const raw = await res.json();
    const allLeagues = raw.leagues || [];

    const filtered = allLeagues
      .filter(l => LEAGUE_IDS.has(Number(l.id)))
      .map(l => ({
        id:      l.id,
        name:    l.name,
        ccode:   l.ccode || '',
        matches: (l.matches || []).map(m => ({
          id:       m.id,
          home:     m.home?.name     || 'TBC',
          homeId:   m.home?.id,
          away:     m.away?.name     || 'TBC',
          awayId:   m.away?.id,
          utcTime:  m.status?.utcTime || null,
          started:  m.status?.started  || false,
          finished: m.status?.finished || false,
          score:    m.status?.scoreStr || null,
          link:     `https://www.fotmob.com/matches/${m.id}`
        }))
      }))
      .filter(l => l.matches.length > 0);

    return respond(true, { date, total: filtered.reduce((n, l) => n + l.matches.length, 0), leagues: filtered });

  } catch (err) {
    return respond(false, { error: err.message });
  }
};

function respond(ok, body) {
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ ok, ...body })
  };
}

function todayStr() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

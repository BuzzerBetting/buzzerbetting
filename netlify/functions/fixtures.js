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
]);

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const date = event.queryStringParameters?.date || todayStr();

  try {
    const { default: Fotmob } = await import('@max-xoo/fotmob');
    const fotmob = new Fotmob();
    const raw = await fotmob.getMatchesByDate(date);
    const allLeagues = raw.leagues || [];

    const filtered = allLeagues
      .filter(l => LEAGUE_IDS.has(Number(l.id)))
      .map(l => ({
        id: l.id,
        name: l.name,
        ccode: l.ccode || '',
        matches: (l.matches || []).map(m => ({
          id: m.id,
          home: m.home?.name || 'TBC',
          away: m.away?.name || 'TBC',
          utcTime: m.status?.utcTime || null,
          started: m.status?.started || false,
          finished: m.status?.finished || false,
          score: m.status?.scoreStr || null,
          link: `https://www.fotmob.com/matches/${m.id}`
        }))
      }))
      .filter(l => l.matches.length > 0);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, date, total: filtered.reduce((n, l) => n + l.matches.length, 0), leagues: filtered })
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};

function todayStr() {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
}

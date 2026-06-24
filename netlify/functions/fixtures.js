const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  const date = event.queryStringParameters?.date || todayStr();

  const res = await fetch(`https://www.fotmob.com/api/data/matches?date=${date}&timezone=Europe%2FLondon&ccode3=GBR&includeNextDayLateNight=true`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.fotmob.com/'
    }
  });

  const raw = await res.json();

  // Return raw response so we can see the full structure
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      status: res.status,
      leagueCount: (raw.leagues || []).length,
      leagueIds: (raw.leagues || []).map(l => ({ id: l.id, name: l.name, matchCount: (l.matches||[]).length })),
      rawSample: JSON.stringify(raw).slice(0, 500)
    })
  };
};

function todayStr() {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
}

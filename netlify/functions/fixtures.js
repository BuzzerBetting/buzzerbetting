const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};
const DO_HOST = '178.128.40.248';
const DO_PORT = 3000;

// Fetches the current league list from the Ledger backend — this used to be a hardcoded
// PRIMARY_IDS set here, now editable via the "Edit Leagues" button on Today's Matches
// instead of requiring a code change every time a new competition needs adding.
async function fetchLeagueIds() {
  const res = await fetch(`http://${DO_HOST}:${DO_PORT}/api/ledger/fotmob-leagues`, {
    headers: { 'x-ledger-key': process.env.LEDGER_API_KEY || '' }
  });
  if (!res.ok) throw new Error(`Ledger backend returned HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Failed to load league list');
  return new Set((data.leagues || []).map(l => Number(l.league_id)));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const date = event.queryStringParameters?.date || todayStr();
  const dateFormatted = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
  try {
    const [primaryIds, res] = await Promise.all([
      fetchLeagueIds(),
      fetch(`https://www.fotmob.com/api/data/matches?date=${date}&timezone=Europe%2FLondon&ccode3=GBR&includeNextDayLateNight=true`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Referer': 'https://www.fotmob.com/'
        }
      })
    ]);
    if (!res.ok) throw new Error(`FotMob returned HTTP ${res.status}`);
    const raw = await res.json();
    const allLeagues = raw.leagues || [];
    const filtered = allLeagues
      .filter(l => primaryIds.size === 0 || primaryIds.has(Number(l.primaryId || l.id)))
      .map(l => ({
        id: l.primaryId || l.id,
        name: l.parentLeagueName || l.name,
        ccode: l.ccode || '',
        matches: (l.matches || [])
          .filter(m => {
            const t = m.status?.utcTime || '';
            return t.startsWith(dateFormatted);
          })
          .map(m => ({
            id: m.id,
            home: m.home?.name || 'TBC',
            homeId: m.home?.id,
            away: m.away?.name || 'TBC',
            awayId: m.away?.id,
            utcTime: m.status?.utcTime || null,
            started: m.status?.started || false,
            finished: m.status?.finished || false,
            score: m.status?.scoreStr || null,
            link: `https://www.fotmob.com/matches/${m.id}`
          }))
      }))
      .filter(l => l.matches.length > 0);
    const grouped = [];
    const seen = new Map();
    filtered.forEach(l => {
      const key = l.name;
      if (!seen.has(key)) {
        seen.set(key, { id: l.id, name: l.name, ccode: l.ccode, matches: [] });
        grouped.push(seen.get(key));
      }
      seen.get(key).matches.push(...l.matches);
    });
    grouped.forEach(l => {
      l.matches.sort((a, b) => new Date(a.utcTime) - new Date(b.utcTime));
    });
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        date,
        total: grouped.reduce((n, l) => n + l.matches.length, 0),
        leagues: grouped
      })
    };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
function todayStr() {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
}

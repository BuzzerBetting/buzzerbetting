// Last-resort default — used only if the DO server's league list can't be fetched (down,
// misconfigured LEDGER_API_KEY, etc.), so Today's Matches degrades gracefully instead of
// showing nothing. Under normal operation the live list always comes from the DB via
// fetchLeagueIds() below, so editing leagues through the "Edit Leagues" UI takes effect
// immediately without redeploying this function.
const DEFAULT_PRIMARY_IDS = new Set([
  77,  // FIFA World Cup 2026
  47,  // Premier League
  48,  // Championship
  87,  // La Liga
  54,  // Bundesliga
  55,  // Serie A
  53,  // Ligue 1
  42,  // UEFA Champions League
  73,  // UEFA Europa League
  40,  // FA Cup
]);

// Read from env vars first so each independent deployment (each with its own DO server)
// can point at its own backend without editing this file — falls back to the original
// hardcoded values only if unset, so the existing deployment needs zero changes. Same
// pattern as netlify/functions/ledger.js.
const DO_HOST = process.env.LEDGER_DO_HOST || '178.128.40.248';
const DO_PORT = process.env.LEDGER_DO_PORT ? Number(process.env.LEDGER_DO_PORT) : 3000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

// Fetches the current editable league list from the DO server (same DB/route the "Edit
// Leagues" modal writes to) and returns it as a Set of numeric FotMob league IDs. Falls
// back to DEFAULT_PRIMARY_IDS on any failure — network error, DO server down, or
// LEDGER_API_KEY missing — so this endpoint never hard-fails just because the ledger
// backend is briefly unreachable.
async function fetchLeagueIds() {
  if (!process.env.LEDGER_API_KEY) return DEFAULT_PRIMARY_IDS;
  try {
    const res = await fetch(`http://${DO_HOST}:${DO_PORT}/api/ledger/fotmob-leagues`, {
      headers: { 'x-ledger-key': process.env.LEDGER_API_KEY }
    });
    if (!res.ok) return DEFAULT_PRIMARY_IDS;
    const d = await res.json();
    if (!d.ok || !Array.isArray(d.leagues) || !d.leagues.length) return DEFAULT_PRIMARY_IDS;
    return new Set(d.leagues.map(l => Number(l.league_id)));
  } catch (e) {
    return DEFAULT_PRIMARY_IDS;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const date = event.queryStringParameters?.date || todayStr();
  const dateFormatted = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;

  try {
    const PRIMARY_IDS = await fetchLeagueIds();
    const url = `https://www.fotmob.com/api/data/matches?date=${date}&timezone=Europe%2FLondon&ccode3=GBR&includeNextDayLateNight=true`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.fotmob.com/'
      }
    });

    if (!res.ok) throw new Error(`FotMob returned HTTP ${res.status}`);

    const raw = await res.json();
    const allLeagues = raw.leagues || [];

    const filtered = allLeagues
      .filter(l => PRIMARY_IDS.size === 0 || PRIMARY_IDS.has(Number(l.primaryId || l.id)))
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

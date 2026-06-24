const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const FOTMOB_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.fotmob.com/'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const { matchId } = event.queryStringParameters || {};
  if (!matchId) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'matchId required' }) };

  try {
    const url = `https://www.fotmob.com/api/data/matchDetails?matchId=${matchId}`;
    const res = await fetch(url, { headers: FOTMOB_HEADERS });
    if (!res.ok) throw new Error(`FotMob returned HTTP ${res.status}`);

    const data = await res.json();
    const lineup = data?.content?.lineup;

    if (!lineup) throw new Error('No lineup data available');

    const parseTeam = (team) => {
      if (!team) return null;
      const starters = (team.starters || team.players || []).map(p => ({
        id:        p.id,
        name:      p.name?.fullName || p.name,
        shirt:     p.shirt,
        position:  p.pos || p.role,
        isCaptain: p.captain || false,
      }));
      const bench = (team.bench || team.subs || []).map(p => ({
        id:       p.id,
        name:     p.name?.fullName || p.name,
        shirt:    p.shirt,
        position: p.pos || p.role,
      }));
      return { starters, bench };
    };

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        matchId,
        confirmed: lineup.confirmed || false,
        home: {
          id:     lineup.homeTeam?.teamId,
          name:   lineup.homeTeam?.teamName,
          lineup: parseTeam(lineup.homeTeam),
        },
        away: {
          id:     lineup.awayTeam?.teamId,
          name:   lineup.awayTeam?.teamName,
          lineup: parseTeam(lineup.awayTeam),
        },
        // Debug — remove once working
        homeTeamKeys: lineup.homeTeam ? Object.keys(lineup.homeTeam) : []
      })
    };

  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const FOTMOB_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.fotmob.com/'
};

const INTL_SEASONS = new Set([0]);

const SEASON_IDS = [];
for (let s = 0; s <= 3; s++) {
  for (let c = 0; c <= 6; c++) {
    SEASON_IDS.push(`${s}-${c}`);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const { playerId, matchType } = event.queryStringParameters || {};
  if (!playerId) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'playerId required' }) };

  const isInternational = matchType === 'international';

  try {
    const results = await Promise.allSettled(
      SEASON_IDS.map(async (seasonId) => {
        const season = parseInt(seasonId.split('-')[0]);
        const url = `https://www.fotmob.com/api/data/playerStats?playerId=${playerId}&seasonId=${seasonId}&isFirstSeason=false`;
        const res = await fetch(url, { headers: FOTMOB_HEADERS });
        if (!res.ok) return null;
        const data = await res.json();
        const shots = data?.shotmap;
        if (!shots || !shots.length) return null;
        return { seasonId, season, shots, isIntl: INTL_SEASONS.has(season) };
      })
    );

    const allDatasets = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    if (!allDatasets.length) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'No shot data found for this player' }) };

    const relevant = isInternational ? allDatasets : allDatasets.filter(d => !d.isIntl);
    const allShots = relevant.flatMap(d => d.shots);
    const sorted = [...allShots].sort((a, b) => new Date(b.matchDate) - new Date(a.matchDate));
    const currentTeamId = sorted[0]?.teamId;
    const currentTeamShots = allShots.filter(s => s.teamId === currentTeamId);

    const agg = (datasets) => calcStats(datasets.flatMap(d => d.shots));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        playerId,
        matchType: matchType || 'club',
        currentTeamId,
        timeframes: {
          currentTeam:   calcStats(currentTeamShots),
          currentSeason: agg(relevant.filter(d => d.season <= 1)),
          lastSeason:    agg(relevant.filter(d => d.season <= 2)),
          last2Seasons:  agg(relevant.filter(d => d.season <= 3)),
        },
        competitionsFound: allDatasets.map(d => ({ seasonId: d.seasonId, shots: d.shots.length, isIntl: d.isIntl }))
      })
    };

  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

function calcStats(shots) {
  if (!shots || !shots.length) return null;
  const matches   = new Set(shots.map(s => s.matchId)).size;
  const goals     = shots.filter(s => s.eventType === 'Goal').length;
  const totalShots= shots.length;
  const sot       = shots.filter(s => s.isOnTarget).length;

  const headers      = shots.filter(s => s.shotType === 'Header').length;
  const headedSot    = shots.filter(s => s.shotType === 'Header' && s.isOnTarget).length;
  const headedGoals  = shots.filter(s => s.shotType === 'Header' && s.eventType === 'Goal').length;
  const headedXG     = sum(shots.filter(s => s.shotType === 'Header'));

  const leftFoot     = shots.filter(s => s.shotType === 'LeftFoot').length;
  const leftFootSot  = shots.filter(s => s.shotType === 'LeftFoot' && s.isOnTarget).length;
  const leftFootGoals= shots.filter(s => s.shotType === 'LeftFoot' && s.eventType === 'Goal').length;
  const leftFootXG   = sum(shots.filter(s => s.shotType === 'LeftFoot'));

  const rightFoot    = shots.filter(s => s.shotType === 'RightFoot').length;
  const rightFootSot = shots.filter(s => s.shotType === 'RightFoot' && s.isOnTarget).length;
  const rightFootGoals=shots.filter(s => s.shotType === 'RightFoot' && s.eventType === 'Goal').length;
  const rightFootXG  = sum(shots.filter(s => s.shotType === 'RightFoot'));

  const otb          = s => s.situation === 'RegularPlay' || s.situation === 'FastBreak';
  const otbShots     = shots.filter(otb).length;
  const otbSot       = shots.filter(s => otb(s) && s.isOnTarget).length;
  const otbGoals     = shots.filter(s => otb(s) && s.eventType === 'Goal').length;
  const otbXG        = sum(shots.filter(otb));

  // Penalty shots and free kick shots (count of attempts, not just goals)
  const penShotsArr  = shots.filter(s => s.situation === 'Penalty');
  const fkShotsArr   = shots.filter(s => s.situation === 'SetPiece');
  const penaltyShots = penShotsArr.length;
  const freeKickShots= fkShotsArr.length;
  const penaltyXG    = sum(penShotsArr);
  const freeKickXG   = sum(fkShotsArr);
  const penaltyGoals = penShotsArr.filter(s => s.eventType === 'Goal').length;
  const freeKickGoals= fkShotsArr.filter(s => s.eventType === 'Goal').length;

  const insideBox    = shots.filter(s => s.box === 'InsideBox').length;
  const outsideBox   = shots.filter(s => s.box === 'OutsideBox').length;
  const totalXG      = sum(shots);
  const pg = (n) => matches > 0 ? r(n / matches) : 0;

  return {
    matches, goals, shots: totalShots, sot, xG: r(totalXG),
    headers, headedSot, headedGoals, headedXG: r(headedXG),
    leftFoot, leftFootSot, leftFootGoals, leftFootXG: r(leftFootXG),
    rightFoot, rightFootSot, rightFootGoals, rightFootXG: r(rightFootXG),
    otbShots, otbSot, otbGoals, otbXG: r(otbXG),
    penaltyShots, penaltyGoals, penaltyXG: r(penaltyXG),
    freeKickShots, freeKickGoals, freeKickXG: r(freeKickXG),
    insideBox, outsideBox,
    shotsPerGame: pg(totalShots), sotPerGame: pg(sot),
    goalsPerGame: pg(goals), xGPerGame: pg(totalXG),
    headersPerGame: pg(headers), otbPerGame: pg(otbShots),
  };
}

function sum(shots) { return shots.reduce((t, s) => t + (s.expectedGoals || 0), 0); }
function r(n) { return Math.round(n * 100) / 100; }

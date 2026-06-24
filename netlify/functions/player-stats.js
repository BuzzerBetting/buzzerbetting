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

  // Exclude FromCorner and SetPiece (set piece deliveries) from all calculations
  // Only count: RegularPlay, FastBreak, Penalty, FreeKick
  const VALID = new Set(['RegularPlay','FastBreak','Penalty','FreeKick']);
  const s = shots.filter(sh => VALID.has(sh.situation));

  if (!s.length) return null;
  const matches   = new Set(s.map(sh => sh.matchId)).size;
  const goals     = s.filter(sh => sh.eventType === 'Goal').length;
  const totalShots= s.length;
  const sot       = s.filter(sh => sh.isOnTarget).length;

  const headers      = s.filter(sh => sh.shotType === 'Header').length;
  const headedSot    = s.filter(sh => sh.shotType === 'Header' && sh.isOnTarget).length;
  const headedGoals  = s.filter(sh => sh.shotType === 'Header' && sh.eventType === 'Goal').length;
  const headedXG     = sum(s.filter(sh => sh.shotType === 'Header'));

  const leftFoot     = s.filter(sh => sh.shotType === 'LeftFoot').length;
  const leftFootSot  = s.filter(sh => sh.shotType === 'LeftFoot' && sh.isOnTarget).length;
  const leftFootGoals= s.filter(sh => sh.shotType === 'LeftFoot' && sh.eventType === 'Goal').length;
  const leftFootXG   = sum(s.filter(sh => sh.shotType === 'LeftFoot'));

  const rightFoot    = s.filter(sh => sh.shotType === 'RightFoot').length;
  const rightFootSot = s.filter(sh => sh.shotType === 'RightFoot' && sh.isOnTarget).length;
  const rightFootGoals=s.filter(sh => sh.shotType === 'RightFoot' && sh.eventType === 'Goal').length;
  const rightFootXG  = sum(s.filter(sh => sh.shotType === 'RightFoot'));

  const otb          = sh => sh.situation === 'RegularPlay' || sh.situation === 'FastBreak';
  const otbShots     = s.filter(otb).length;
  const otbSot       = s.filter(sh => otb(sh) && sh.isOnTarget).length;
  const otbGoals     = s.filter(sh => otb(sh) && sh.eventType === 'Goal').length;
  const otbXG        = sum(s.filter(otb));

  // Penalty shots
  const penShotsArr  = s.filter(sh => sh.situation === 'Penalty');
  const penaltyShots = penShotsArr.length;
  const penaltySot   = penShotsArr.filter(sh => sh.isOnTarget).length;
  const penaltyXG    = sum(penShotsArr);
  const penaltyGoals = penShotsArr.filter(sh => sh.eventType === 'Goal').length;

  // Direct free kick shots only
  const fkShotsArr   = s.filter(sh => sh.situation === 'FreeKick');
  const freeKickShots= fkShotsArr.length;
  const freeKickSot  = fkShotsArr.filter(sh => sh.isOnTarget).length;
  const freeKickXG   = sum(fkShotsArr);
  const freeKickGoals= fkShotsArr.filter(sh => sh.eventType === 'Goal').length;

  const insideBox    = s.filter(sh => sh.box === 'InsideBox').length;
  const outsideBox   = s.filter(sh => sh.box === 'OutsideBox').length;
  const totalXG      = sum(s);
  const pg = (n) => matches > 0 ? r(n / matches) : 0;

  return {
    matches, goals, shots: totalShots, sot, xG: r(totalXG),
    headers, headedSot, headedGoals, headedXG: r(headedXG),
    leftFoot, leftFootSot, leftFootGoals, leftFootXG: r(leftFootXG),
    rightFoot, rightFootSot, rightFootGoals, rightFootXG: r(rightFootXG),
    otbShots, otbSot, otbGoals, otbXG: r(otbXG),
    penaltyShots, penaltyGoals, penaltySot, penaltyXG: r(penaltyXG),
    freeKickShots, freeKickGoals, freeKickSot, freeKickXG: r(freeKickXG),
    insideBox, outsideBox,
    shotsPerGame: pg(totalShots), sotPerGame: pg(sot),
    goalsPerGame: pg(goals), xGPerGame: pg(totalXG),
    headersPerGame: pg(headers), otbPerGame: pg(otbShots),
  };
}

function sum(shots) { return shots.reduce((t, s) => t + (s.expectedGoals || 0), 0); }
function r(n) { return Math.round(n * 100) / 100; }

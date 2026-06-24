const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const FOTMOB_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.fotmob.com/'
};

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
        return { seasonId, season, shots };
      })
    );

    const allDatasets = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    if (!allDatasets.length) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'No shot data found for this player' }) };

    // Detect current club = most frequent teamId in season 0 shots
    // (more shots = club, fewer = international duty like WC/AFCON)
    const season0Shots = allDatasets.filter(d => d.season === 0).flatMap(d => d.shots);
    const teamCounts = {};
    season0Shots.forEach(s => { teamCounts[s.teamId] = (teamCounts[s.teamId] || 0) + 1; });
    const currentTeamId = Object.entries(teamCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

    if (!currentTeamId) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'Could not detect current team' }) };

    // Club shots = shots where teamId matches current club
    // International shots = shots where teamId does NOT match current club
    const filterShots = (shots) => isInternational
      ? shots.filter(s => s.teamId !== currentTeamId)
      : shots.filter(s => s.teamId === currentTeamId);

    const agg = (datasets) => calcStats(filterShots(datasets.flatMap(d => d.shots)));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        playerId,
        matchType: matchType || 'club',
        currentTeamId,
        timeframes: {
          currentTeam:   agg(allDatasets.filter(d => d.season === 0)),
          currentSeason: agg(allDatasets.filter(d => d.season === 0)),
          lastSeason:    agg(allDatasets.filter(d => d.season <= 1)),
          last2Seasons:  agg(allDatasets.filter(d => d.season <= 2)),
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

  // Raw totals (all situations) — used as denominators to preserve proportions
  const rawShots = shots.length;
  const rawSot   = shots.filter(sh => sh.eventType === 'Goal' || sh.eventType === 'AttemptSaved').length;

  // Exclude FromCorner and SetPiece from all calculations
  const VALID = new Set(['RegularPlay','FastBreak','Penalty','FreeKick']);
  const s = shots.filter(sh => VALID.has(sh.situation));

  if (!s.length) return null;
  const matches   = new Set(s.map(sh => sh.matchId)).size;
  const goals     = s.filter(sh => sh.eventType === 'Goal').length;
  const totalShots= s.length;
  // SOT = goals + keeper saves only (not blocked shots) — matches FotMob's official definition
  const sot       = s.filter(sh => sh.eventType === 'Goal' || sh.eventType === 'AttemptSaved').length;

  const headers      = s.filter(sh => sh.shotType === 'Header').length;
  const headedSot    = s.filter(sh => sh.shotType === 'Header' && sh.eventType === 'Goal' || sh.eventType === 'AttemptSaved').length;
  const headedGoals  = s.filter(sh => sh.shotType === 'Header' && sh.eventType === 'Goal').length;
  const headedXG     = sum(s.filter(sh => sh.shotType === 'Header'));

  const leftFoot     = s.filter(sh => sh.shotType === 'LeftFoot').length;
  const leftFootSot  = s.filter(sh => sh.shotType === 'LeftFoot' && sh.eventType === 'Goal' || sh.eventType === 'AttemptSaved').length;
  const leftFootGoals= s.filter(sh => sh.shotType === 'LeftFoot' && sh.eventType === 'Goal').length;
  const leftFootXG   = sum(s.filter(sh => sh.shotType === 'LeftFoot'));

  const rightFoot    = s.filter(sh => sh.shotType === 'RightFoot').length;
  const rightFootSot = s.filter(sh => sh.shotType === 'RightFoot' && sh.eventType === 'Goal' || sh.eventType === 'AttemptSaved').length;
  const rightFootGoals=s.filter(sh => sh.shotType === 'RightFoot' && sh.eventType === 'Goal').length;
  const rightFootXG  = sum(s.filter(sh => sh.shotType === 'RightFoot'));

  const otb          = sh => sh.situation === 'RegularPlay' || sh.situation === 'FastBreak';
  const otbShots     = s.filter(otb).length;
  const otbSot       = s.filter(sh => otb(sh) && sh.eventType === 'Goal' || sh.eventType === 'AttemptSaved').length;
  const otbGoals     = s.filter(sh => otb(sh) && sh.eventType === 'Goal').length;
  const otbXG        = sum(s.filter(otb));

  // Penalty shots
  const penShotsArr  = s.filter(sh => sh.situation === 'Penalty');
  const penaltyShots = penShotsArr.length;
  const penaltySot   = penShotsArr.filter(sh => sh.eventType === 'Goal' || sh.eventType === 'AttemptSaved').length;
  const penaltyXG    = sum(penShotsArr);
  const penaltyGoals = penShotsArr.filter(sh => sh.eventType === 'Goal').length;

  // Direct free kick shots only
  const fkShotsArr   = s.filter(sh => sh.situation === 'FreeKick');
  const freeKickShots= fkShotsArr.length;
  const freeKickSot  = fkShotsArr.filter(sh => sh.eventType === 'Goal' || sh.eventType === 'AttemptSaved').length;
  const freeKickXG   = sum(fkShotsArr);
  const freeKickGoals= fkShotsArr.filter(sh => sh.eventType === 'Goal').length;

  const insideBox    = s.filter(sh => sh.box === 'InsideBox').length;
  const outsideBox   = s.filter(sh => sh.box === 'OutsideBox').length;
  const totalXG      = sum(s);
  const pg = (n) => matches > 0 ? r(n / matches) : 0;

  return {
    matches, goals, shots: totalShots, sot, xG: r(totalXG),
    rawShots, rawSot,
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

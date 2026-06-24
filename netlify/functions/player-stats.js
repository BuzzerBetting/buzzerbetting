// BuzzerBetting — FotMob Player Stats Aggregator

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const FOTMOB_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.fotmob.com/'
};

// International competition season indices (season 0 = World Cup etc.)
const INTL_SEASONS = new Set([0]);

// Season/comp combos to try — seasons 0-3, comp indices 0-6
const SEASON_IDS = [];
for (let s = 0; s <= 3; s++) {
  for (let c = 0; c <= 6; c++) {
    SEASON_IDS.push(`${s}-${c}`);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const { playerId, matchType } = event.queryStringParameters || {};
  if (!playerId) return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ ok: false, error: 'playerId required' })
  };

  const isInternational = matchType === 'international';

  try {
    // Fetch all season/comp combos concurrently
    const results = await Promise.allSettled(
      SEASON_IDS.map(async (seasonId) => {
        const season = parseInt(seasonId.split('-')[0]);
        const url = `https://www.fotmob.com/api/data/playerStats?playerId=${playerId}&seasonId=${seasonId}&isFirstSeason=false`;
        const res = await fetch(url, { headers: FOTMOB_HEADERS });
        if (!res.ok) return null;
        const data = await res.json();
        const shots = data?.shotmap;
        if (!shots || !shots.length) return null;
        const isIntl = INTL_SEASONS.has(season);
        return { seasonId, season, shots, isIntl };
      })
    );

    // Collect valid datasets
    const allDatasets = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    if (!allDatasets.length) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ ok: false, error: 'No shot data found for this player' })
      };
    }

    // Filter by matchType
    // Club: exclude international seasons
    // International: include everything (club + intl combined)
    const relevant = isInternational
      ? allDatasets
      : allDatasets.filter(d => !d.isIntl);

    // Get current teamId from most recent shot across all datasets
    const allShots = relevant.flatMap(d => d.shots);
    const sorted = [...allShots].sort((a, b) => new Date(b.matchDate) - new Date(a.matchDate));
    const currentTeamId = sorted[0]?.teamId;

    // Helper to aggregate shots from a filtered set of datasets
    const agg = (datasets) => calcStats(datasets.flatMap(d => d.shots));

    // Current team: only shots where teamId matches current team
    const currentTeamShots = allShots.filter(s => s.teamId === currentTeamId);

    // Timeframes by season number
    // season 1 = current club season, season 0 = current intl
    // season 2 = last year, season 3 = two years ago
    const currentSeasonDatasets  = relevant.filter(d => d.season <= 1);
    const lastSeasonDatasets      = relevant.filter(d => d.season <= 2);
    const last2SeasonsDatasets    = relevant.filter(d => d.season <= 3);

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
          currentSeason: agg(currentSeasonDatasets),
          lastSeason:    agg(lastSeasonDatasets),
          last2Seasons:  agg(last2SeasonsDatasets),
        },
        competitionsFound: allDatasets.map(d => ({
          seasonId: d.seasonId,
          shots: d.shots.length,
          isIntl: d.isIntl
        }))
      })
    };

  } catch (err) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};

function calcStats(shots) {
  if (!shots || !shots.length) return null;

  const matches = new Set(shots.map(s => s.matchId)).size;

  // Goals
  const goals        = shots.filter(s => s.eventType === 'Goal').length;

  // Shots & SOT
  const totalShots   = shots.length;
  const sot          = shots.filter(s => s.isOnTarget).length;

  // Headers
  const headers      = shots.filter(s => s.shotType === 'Header').length;
  const headedSot    = shots.filter(s => s.shotType === 'Header' && s.isOnTarget).length;
  const headedGoals  = shots.filter(s => s.shotType === 'Header' && s.eventType === 'Goal').length;
  const headedXG     = sum(shots.filter(s => s.shotType === 'Header'));

  // Foot
  const leftFoot     = shots.filter(s => s.shotType === 'LeftFoot').length;
  const leftFootSot  = shots.filter(s => s.shotType === 'LeftFoot' && s.isOnTarget).length;
  const leftFootGoals= shots.filter(s => s.shotType === 'LeftFoot' && s.eventType === 'Goal').length;
  const leftFootXG   = sum(shots.filter(s => s.shotType === 'LeftFoot'));

  const rightFoot    = shots.filter(s => s.shotType === 'RightFoot').length;
  const rightFootSot = shots.filter(s => s.shotType === 'RightFoot' && s.isOnTarget).length;
  const rightFootGoals=shots.filter(s => s.shotType === 'RightFoot' && s.eventType === 'Goal').length;
  const rightFootXG  = sum(shots.filter(s => s.shotType === 'RightFoot'));

  // OTB (open play — regular play + fast break, excludes corners, set pieces, penalties)
  const otb          = s => s.situation === 'RegularPlay' || s.situation === 'FastBreak';
  const otbShots     = shots.filter(otb).length;
  const otbSot       = shots.filter(s => otb(s) && s.isOnTarget).length;
  const otbGoals     = shots.filter(s => otb(s) && s.eventType === 'Goal').length;
  const otbXG        = sum(shots.filter(otb));

  // Set pieces
  const penalties    = shots.filter(s => s.situation === 'Penalty');
  const penaltyXG    = sum(penalties);
  const penaltyGoals = penalties.filter(s => s.eventType === 'Goal').length;

  const freeKicks    = shots.filter(s => s.situation === 'SetPiece');
  const freeKickXG   = sum(freeKicks);
  const freeKickGoals= freeKicks.filter(s => s.eventType === 'Goal').length;

  // Box
  const insideBox    = shots.filter(s => s.box === 'InsideBox').length;
  const outsideBox   = shots.filter(s => s.box === 'OutsideBox').length;

  // Total xG
  const totalXG      = sum(shots);

  // Per game
  const pg = (n) => matches > 0 ? r(n / matches) : 0;

  return {
    matches,
    goals,
    shots:          totalShots,
    sot,
    xG:             r(totalXG),

    headers,
    headedSot,
    headedGoals,
    headedXG:       r(headedXG),

    leftFoot,
    leftFootSot,
    leftFootGoals,
    leftFootXG:     r(leftFootXG),

    rightFoot,
    rightFootSot,
    rightFootGoals,
    rightFootXG:    r(rightFootXG),

    otbShots,
    otbSot,
    otbGoals,
    otbXG:          r(otbXG),

    penaltyGoals,
    penaltyXG:      r(penaltyXG),

    freeKickGoals,
    freeKickXG:     r(freeKickXG),

    insideBox,
    outsideBox,

    // Per game
    shotsPerGame:   pg(totalShots),
    sotPerGame:     pg(sot),
    goalsPerGame:   pg(goals),
    xGPerGame:      pg(totalXG),
    headersPerGame: pg(headers),
    otbPerGame:     pg(otbShots),
  };
}

// Sum expectedGoals from an array of shots
function sum(shots) {
  return shots.reduce((t, s) => t + (s.expectedGoals || 0), 0);
}

// Round to 2dp
function r(n) {
  return Math.round(n * 100) / 100;
}

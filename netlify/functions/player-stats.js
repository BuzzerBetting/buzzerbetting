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
  for (let c = 0; c <= 10; c++) {
    SEASON_IDS.push(`${s}-${c}`);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const { playerId, matchType, mode } = event.queryStringParameters || {};
  if (!playerId) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'playerId required' }) };
  if (mode === 'career') return careerTotals(playerId);

  const isInternational = matchType === 'international';

  try {
    const results = await Promise.allSettled(
      SEASON_IDS.map(async (seasonId) => {
        const season = parseInt(seasonId.split('-')[0]);
        const url = `https://www.fotmob.com/api/data/playerStats?playerId=${playerId}&seasonId=${seasonId}&isFirstSeason=false`;
        const res = await fetch(url, { headers: FOTMOB_HEADERS });
        if (!res.ok) return null;
        const data = await res.json();
        const shots = data?.shotmap || [];
        const matchesItem = data?.topStatCard?.items?.find(i => i.localizedTitleId === 'matches_uppercase');
        const matchesPlayed = matchesItem ? parseInt(matchesItem.statValue) || 0 : 0;
        if (!shots.length && !matchesPlayed) return null;
        return { seasonId, season, shots, matchesPlayed };
      })
    );

    const allDatasets = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    if (!allDatasets.length) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'No shot data found for this player' }) };

    // For international, use all shots regardless of club
    // For club, detect current team from season 0 shots — but only filter currentTeam timeframe
    let currentTeamId = null;

    if (!isInternational) {
      const season0Shots = allDatasets.filter(d => d.season === 0).flatMap(d => d.shots);
      const teamCounts = {};
      season0Shots.forEach(s => { teamCounts[s.teamId] = (teamCounts[s.teamId] || 0) + 1; });
      currentTeamId = Object.entries(teamCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

      if (!currentTeamId) return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ ok: false, error: 'Could not detect current team' })
      };
    }

    // Filter for current team only (used for currentTeam timeframe)
    const filterCurrentTeam = (shots) => isInternational
      ? shots
      : shots.filter(s => String(s.teamId) === String(currentTeamId));

    // For historical timeframes (lastSeason, last2Seasons) — include ALL clubs
    const filterAll = (shots) => shots;

    const agg = (datasets, filterFn) => {
      const shots = filterFn(datasets.flatMap(d => d.shots));
      const matches = datasets.reduce((t, d) => t + d.matchesPlayed, 0);
      return calcStats(shots, matches || null);
    };

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        playerId,
        matchType: matchType || 'club',
        currentTeamId,
        timeframes: {
          currentTeam:   agg(allDatasets.filter(d => d.season === 0), filterCurrentTeam),
          currentSeason: agg(allDatasets.filter(d => d.season === 0), filterCurrentTeam),
          lastSeason:    agg(allDatasets.filter(d => d.season <= 1), filterAll),
          last2Seasons:  agg(allDatasets.filter(d => d.season <= 2), filterAll),
        },
        competitionsFound: allDatasets.map(d => ({ seasonId: d.seasonId, shots: d.shots.length })),
        debug: (() => {
          const s0shots = allDatasets.filter(d => d.season === 0).flatMap(d => d.shots)
            .filter(s => !currentTeamId || String(s.teamId) === String(currentTeamId));
          const counts = {};
          s0shots.forEach(s => { counts[s.eventType] = (counts[s.eventType]||0)+1; });
          return { totalShots: s0shots.length, eventTypes: counts };
        })()
      })
    };

  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

// mode=career (2026-09-28, for the Outliers tab's per-player context): plain season totals —
// matches, minutes, goals, assists, shots, SOT, yellow/red cards — summed across EVERY
// competition slot for the current season plus the two before it (seasons 0-2). Read straight
// off each playerStats response's topStatCard/statsSection values, not rebuilt from the
// shotmap, since cards/assists/minutes aren't in the shotmap at all.
const CAREER_SEASONS = [0, 1, 2];
const CAREER_STAT_KEYS = {
  matches_uppercase: 'matches', minutes_played: 'minutes', goals: 'goals', assists: 'assists',
  shots: 'shots', ShotsOnTarget: 'sot', yellow_cards: 'yellows', red_cards: 'reds',
};
async function careerTotals(playerId) {
  const ids = SEASON_IDS.filter(id => CAREER_SEASONS.includes(parseInt(id.split('-')[0])));
  const results = await Promise.allSettled(ids.map(async (seasonId) => {
    const url = `https://www.fotmob.com/api/data/playerStats?playerId=${playerId}&seasonId=${seasonId}&isFirstSeason=false`;
    const res = await fetch(url, { headers: FOTMOB_HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    const vals = {};
    const items = [...(data?.topStatCard?.items || []),
      ...((data?.statsSection?.items || []).flatMap(g => g.items || []))];
    for (const it of items) {
      const key = CAREER_STAT_KEYS[it.localizedTitleId];
      if (key && vals[key] == null) vals[key] = parseFloat(it.statValue) || 0;
    }
    return vals.matches ? vals : null;
  }));
  const totals = { matches: 0, minutes: 0, goals: 0, assists: 0, shots: 0, sot: 0, yellows: 0, reds: 0 };
  let competitions = 0;
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    competitions++;
    for (const k of Object.keys(totals)) totals[k] += r.value[k] || 0;
  }
  if (!competitions) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'No season stats found for this player' }) };
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, playerId, seasons: CAREER_SEASONS.length, competitions, totals }) };
}

function calcStats(shots, matchesPlayed) {
  if (!shots || !shots.length) return null;

  const onTgt = sh => (sh.eventType === 'Goal' || sh.eventType === 'AttemptSaved') && !sh.isBlocked;

  const s = shots;
  const matches = matchesPlayed || new Set(s.map(sh => sh.matchId)).size;
  const goals      = s.filter(sh => sh.eventType === 'Goal').length;
  const totalShots = s.length;
  const sot        = s.filter(onTgt).length;

  const isHdr  = sh => sh.shotType === 'Header';
  const isLF   = sh => sh.shotType === 'LeftFoot';
  const isRF   = sh => sh.shotType === 'RightFoot';
  const isOTB  = sh => sh.isFromInsideBox === false;
  const isPen  = sh => sh.situation === 'Penalty';
  const isFK   = sh => sh.situation === 'FreeKick';

  const headers      = s.filter(isHdr).length;
  const headedSot    = s.filter(sh => isHdr(sh) && onTgt(sh)).length;
  const headedGoals  = s.filter(sh => isHdr(sh) && sh.eventType === 'Goal').length;
  const headedXG     = sum(s.filter(isHdr));

  const leftFoot     = s.filter(isLF).length;
  const leftFootSot  = s.filter(sh => isLF(sh) && onTgt(sh)).length;
  const leftFootGoals= s.filter(sh => isLF(sh) && sh.eventType === 'Goal').length;
  const leftFootXG   = sum(s.filter(isLF));

  const rightFoot     = s.filter(isRF).length;
  const rightFootSot  = s.filter(sh => isRF(sh) && onTgt(sh)).length;
  const rightFootGoals= s.filter(sh => isRF(sh) && sh.eventType === 'Goal').length;
  const rightFootXG   = sum(s.filter(isRF));

  const otbShots = s.filter(isOTB).length;
  const otbSot   = s.filter(sh => isOTB(sh) && onTgt(sh)).length;
  const otbGoals = s.filter(sh => isOTB(sh) && sh.eventType === 'Goal').length;
  const otbXG    = sum(s.filter(isOTB));

  const penArr       = s.filter(isPen);
  const penaltyShots = penArr.length;
  const penaltySot   = penArr.filter(onTgt).length;
  const penaltyGoals = penArr.filter(sh => sh.eventType === 'Goal').length;
  const penaltyXG    = sum(penArr);

  const fkArr        = s.filter(isFK);
  const freeKickShots= fkArr.length;
  const freeKickSot  = fkArr.filter(onTgt).length;
  const freeKickGoals= fkArr.filter(sh => sh.eventType === 'Goal').length;
  const freeKickXG   = sum(fkArr);

  const insideBox  = s.filter(sh => sh.isFromInsideBox === true).length;
  const outsideBox = s.filter(sh => sh.isFromInsideBox === false).length;
  const totalXG    = sum(s);
  const pg = n => matches > 0 ? r(n / matches) : 0;

  return {
    matches, goals, shots: totalShots, sot, xG: r(totalXG),
    headers, headedSot, headedGoals, headedXG: r(headedXG), headedTopXG: top2(s.filter(isHdr)),
    leftFoot, leftFootSot, leftFootGoals, leftFootXG: r(leftFootXG), leftFootTopXG: top2(s.filter(isLF)),
    rightFoot, rightFootSot, rightFootGoals, rightFootXG: r(rightFootXG), rightFootTopXG: top2(s.filter(isRF)),
    otbShots, otbSot, otbGoals, otbXG: r(otbXG), otbTopXG: top2(s.filter(isOTB)),
    penaltyShots, penaltyGoals, penaltySot, penaltyXG: r(penaltyXG),
    freeKickShots, freeKickGoals, freeKickSot, freeKickXG: r(freeKickXG),
    insideBox, outsideBox,
    shotsPerGame: pg(totalShots), sotPerGame: pg(sot),
    goalsPerGame: pg(goals), xGPerGame: pg(totalXG),
    headersPerGame: pg(headers), otbPerGame: pg(otbShots),
  };
}

function sum(shots) { return shots.reduce((t, s) => t + (s.expectedGoals || 0), 0); }
// The two biggest single-shot xG values, largest first: gsm_fair.py's spike gate checks whether a
// method's xG rests on one or two big chances.
function top2(shots) { return shots.map(s => s.expectedGoals || 0).sort((a, b) => b - a).slice(0, 2).map(r); }
function r(n) { return Math.round((n + 1e-9) * 100) / 100; }

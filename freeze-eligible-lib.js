// freeze-eligible-lib.js — reads the VA-pasted Acca Freeze coupon (freeze_eligible_list table,
// written by POST /api/ledger/freeze-eligible-list — see freeze-eligible-parser.js for the
// parsing itself) and matches it against a Betfair-spine fixture the same way skybet-bfex-lib.js's
// findSky() matches the (now largely dead) accafreeze feed, and oddsmonkey-lib.js's
// findOddsMonkeySky() matches OddsMonkey. Unlike OddsMonkey, everything here IS Acca-Freeze
// eligible by definition — that's the whole point of this manual paste (confirmed with the
// user 2026-09-09: every match on the real Acca Freeze coupon is a valid freeze target).
const { teamEq } = require('./team-name-match');

function getStoredFreezeEligibleTeams() {
  try {
    const db = require('./ledger-db');
    const row = db.prepare(`SELECT parsed FROM freeze_eligible_list WHERE id = 1`).get();
    if (!row) return [];
    const parsed = JSON.parse(row.parsed || '{}');
    return parsed.teams || [];
  } catch (e) { return []; } // no paste yet, or DB not reachable — just contributes nothing
}

// fx: {home, away, startTime}. Returns {odds: {home, draw, away}} | null.
function findFreezeEligibleMatch(fx, teams) {
  const bt = fx.startTime ? Date.parse(fx.startTime) : null;
  let best = null, bestDelta = Infinity;
  for (const t of teams) {
    if (!(teamEq(fx.home, t.home) && teamEq(fx.away, t.away))) continue;
    const st = t.kickoff ? Date.parse(t.kickoff) : null;
    const delta = (bt && st) ? Math.abs(bt - st) : 0;
    if (bt && st && delta > 6 * 3600e3) continue; // same 6h sanity window as findSky()/findOddsMonkeySky()
    if (delta < bestDelta) { best = t; bestDelta = delta; }
  }
  if (!best) return null;
  return { odds: { home: best.homeOdds, draw: best.drawOdds, away: best.awayOdds } };
}

module.exports = { getStoredFreezeEligibleTeams, findFreezeEligibleMatch };

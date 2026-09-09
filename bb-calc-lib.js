// bb-calc-lib.js — shared BookieBashing model logic, used by both netlify/functions/bb-lead.js
// ("team to lead at any point") and netlify/functions/bb-odds.js (player AGS fair odds).
//
// The VERBATIM section (team-xG derivation) was lifted from BB's own bundle
// (js/daily-goals/dist/assets/index-*.js) on 2026-09-08 for bb-lead.js — see that file's header
// for the full provenance note. Moved here 2026-09-09 so bb-odds.js can share it instead of a
// second hand-copy drifting out of sync.
//
// The player-AGS section (margin removal + Poisson conversion + lineup normalization) was
// reverse-engineered from the same bundle on 2026-09-09 and verified against BB's live Player xG
// "Standard" table to 3 decimal places on two independent examples (Pavlidis 1.86/1.88 raw/norm,
// Aaronson 7.50/8.50 raw/norm) — see PROJECT memory for the full derivation. Unlike BB's own page
// (which requires ITS OWN confirmed-lineup gate — shows nothing pre-lineup, not even the
// un-normalized price), this always returns the pre-lineup "Raw AGS" from market price alone, and
// additionally returns a normalized "BB AGS" whenever the CALLER supplies a confirmed starting XI
// (from our own FotMob lineup data, not BB's) — see computePlayerAgs() below.

/* eslint-disable */
// ─────────────────────────────────────────────────────────────────────────────
// VERBATIM — BookieBashing bundle. Do not "clean up"; re-lift on their next build.
// ─────────────────────────────────────────────────────────────────────────────

const takeStep = kt => kt > 100 ? kt - 10 : kt > 50 ? kt - 5 : kt > 30 ? kt - 2 : kt > 20 ? kt - 1 : kt > 10 ? kt - .5 : kt > 6 ? kt - .2 : kt > 4 ? kt - .1 : kt > 3 ? kt - .05 : kt > 2 ? kt - .02 : kt - .01;

const poissonUnder = (kt, vt) => { let es = 0; for (let ss = 0; ss < vt; ss++) { let ts = 1; for (let os = 1; os <= ss; os++) ts *= kt / os; es += Math.exp(-kt) * ts } return es };
const poissonOver = (kt, vt) => 1 - poissonUnder(kt, Math.floor(vt) + 1);
const basicGoals = (kt, vt, es) => { switch (es) { case "over": return 1 / poissonOver(kt, vt); case "under": return 1 / poissonUnder(kt, vt); case "exactly": return 1 / (poissonUnder(kt, vt + 1) - poissonUnder(kt, vt)); case "between": return 1 / (poissonUnder(kt, vt[1] + 1) - poissonUnder(kt, vt[0])) } return 1 / 0 };

const bbTeamXg = (kt, vt, es, ss, ts, os, is) => { const rs = 1 / kt, ns = 1 / vt, ls = rs / (rs + ns); return (Math.pow(ls, 3) * es + Math.pow(ls, 2) * ss + ls * ts + os) * is };

const normalizeTotal = (kt, vt, es) => { if (!kt || !vt || !es) return kt; const ss = parseFloat(kt.toFixed(2)), ts = parseFloat(vt.toFixed(2)), os = parseFloat(es.toFixed(2)); return (ss + ts).toFixed(2) === os.toFixed(2) ? kt : (ss + ts - os).toFixed(2) === "0.01" ? ss - kt < ts - vt || ss - kt === ts - vt && kt > vt ? kt : ss - .01 : (ss + ts - os).toFixed(2) === "-0.01" ? kt - ss > vt - ts || ss - kt === ts - vt && kt > vt ? ss + .01 : kt : normalizeTotal(kt * es / (kt + vt), vt * es / (kt + vt), es) };

const confidence = kt => kt.last ? !kt.lay || !kt.back ? kt.override && kt.override.fair ? 4 : 5 : kt.last <= kt.lay && kt.last >= kt.back ? takeStep(kt.lay) <= kt.back ? 1 : 2 : kt.back > kt.last ? takeStep(takeStep(takeStep(kt.back))) <= kt.last ? 3 : kt.override && kt.override.fair ? 4 : 5 : takeStep(takeStep(takeStep(kt.last))) <= kt.lay ? 3 : kt.override && kt.override.fair ? 4 : 5 : kt.override && kt.override.fair ? 4 : 6;

const gameXg = (kt, vt = !1) => { if (kt.override && kt.override.xG && kt.override.bookmakerCount && kt.override.bookmakerCount > 0 && kt.xG && (kt.xG > kt.override.xG * 1.25 || kt.xG < kt.override.xG * .75)) return kt.override.xG; if (confidence(kt) === 4) { const es = kt.override && kt.override.xG ? kt.override.xG : vt; return es ? Math.min(es, 10) : !1 } else return kt.xG || vt };

const fairFromBetfair = (kt, vt = !1, es = !1, ss = !1, ts = !1) => { if (!kt || !kt.back) return ss || !1; let os = 0, is = kt.lay; if (is === 1 / 0 || !is) return ss || !1; for (; is > kt.back;) is = takeStep(is), os++; return es && es !== "fair" ? es === "back" ? kt.back : kt.lay || !1 : !kt.last || ts !== "ignore" && os >= 20 ? ss || !1 : kt.back <= kt.last && kt.last <= kt.lay ? ts && ts !== "ignore" && typeof ts == "number" ? os <= ts ? kt.last : ss || !1 : kt.last : kt.back > kt.last ? vt ? takeStep(takeStep(takeStep(kt.back))) <= kt.last ? kt.back : ss || !1 : kt.back : vt ? takeStep(takeStep(takeStep(kt.last))) <= kt.lay ? kt.lay : ss || !1 : kt.lay };

const homeAwayPrices = kt => { if (!kt.home && kt.away && kt.draw) { const vt = 1 / kt.away + 1 / kt.draw; vt < 1 && (kt.home = 1 / (1 - vt)) } if (!kt.away && kt.home && kt.draw) { const vt = 1 / kt.home + 1 / kt.draw; vt < 1 && (kt.away = 1 / (1 - vt)) } };

const singleSpreadMean = (kt, vt, es, ss = !1, ts = !1) => { if (kt[es] && kt[es][vt] !== void 0 && kt[es][vt].buy && (typeof kt[es][vt].buy == "number" || kt[es][vt].buy.length > 0) && kt[es][vt].sell && typeof (typeof kt[es][vt].sell == "number" || kt[es][vt].sell.length > 0)) { const os = typeof kt[es][vt].buy == "number" ? kt[es][vt].buy : parseFloat(kt[es][vt].buy), is = typeof kt[es][vt].sell == "number" ? kt[es][vt].sell : parseFloat(kt[es][vt].sell); return os < is ? !1 : ss !== !1 ? (os - is) * ss + is : kt.lineOverrides && kt.lineOverrides[vt] && kt.lineOverrides[vt] === "mid" || !kt.lineOverrides && ts && ts === "mid" ? (os + is) / 2 : kt.lineOverrides && kt.lineOverrides[vt] && kt.lineOverrides[vt] === "buy" || !kt.lineOverrides && ts && ts === "buy" ? os : kt.lineOverrides && kt.lineOverrides[vt] && kt.lineOverrides[vt] === "sell" || !kt.lineOverrides && ts && ts === "sell" ? is : (os + is) / 2 } return !1 };
const spreadMean = (kt, vt, es = !1, ss = !1) => { const ts = [kt.spreadexDisabled ? !1 : singleSpreadMean(kt, vt, "spreadex", es, ss), kt.siDisabled ? !1 : singleSpreadMean(kt, vt, "sporting-index", es, ss), kt.sportsspreadDisabled ? !1 : singleSpreadMean(kt, vt, "sportsspread", es, ss), kt.starspreadsDisabled ? !1 : singleSpreadMean(kt, vt, "starspreads", es, ss)].filter(os => os !== !1); return ts.length === 0 ? !1 : ts.reduce((os, is) => os + is, 0) / ts.length };

const corners = () => 1 / 0; // unused here (isCorners is always false) — stub so BbCorrectScore parses/runs

class BbCorrectScore {
  constructor(vt = !1, es = null, ss = !1, ts = !1, os = -.13) { this.isCorners = vt, this.coefficients = es, this.correctScoreMarket = ss, this.preCalculated = {}, this.fairSum = !1, this.defaultRemain = !1, this.isDixonColes = ts, this.rho = os }
  calculate(vt, es, ss, ts, os = 100, is = !0) {
    const rs = this.preCalculated[`${vt}-${es}-${ss}-${ts}-${os}-${is}`]; if (rs !== void 0) return rs;
    if (os < 99.99 && is) return console.warn("Match percentage < 100 with correct score market is not supported"), 0;
    if (!ss || !ts) return 0;
    if (ss = ss * os / 100, ts = ts * os / 100, is && this.correctScoreMarket) {
      let ds = this.fairerSum || 0;
      const us = this.fairSum || this.correctScoreMarket.reduce((ws, Ns) => { const xs = fairFromBetfair(Ns, !0); return xs && Ns.selection.substr(0, 1) !== "A" && !(Ns.books && Ns.books.bookmakers && Ns.books.bookmakers.length > 2 && Ns.books.min > xs) ? (xs < 100 && (ds += 1 / xs), ws + 1 / xs) : ws }, 0);
      this.fairSum = us, this.fairerSum = ds;
      const hs = this.correctScoreMarket.find(ws => ws.selection === vt + " - " + es), ms = fairFromBetfair(hs, !0);
      if (hs && hs.books && hs.books.bookmakers && hs.books.bookmakers.length > 2 && ms && hs.books.min > ms) console.log("Invalid BFEX odds, below min bookie odds");
      else if (ms && (us < 1 || ms < 100)) return this.preCalculated[`${vt}-${es}-${ss}-${ts}-${os}-${is}`] = 1 / ms, 1 / ms;
      const gs = this.defaultRemain || 1 - this.correctScoreMarket.reduce((ws, Ns) => { const xs = fairFromBetfair(Ns, !0); if (Ns.selection.indexOf(" - ") === -1 || !xs || us >= 1 && xs >= 100 || Ns.books && Ns.books.bookmakers && Ns.books.bookmakers.length > 2 && Ns.books.min > xs) return ws; { const Ts = Ns.selection.split(" - "); return this.calculate(parseInt(Ts[0]), parseInt(Ts[1]), ss, ts, 100, !1) + ws } }, 0);
      this.defaultRemain = gs;
      const _s = us < 1 ? 1 - us : 1 - ds;
      if (_s < 0) return this.preCalculated[`${vt}-${es}-${ss}-${ts}-${os}-${is}`] = 0, 0;
      const bs = this.calculate(vt, es, ss, ts, 100, !1);
      return bs ? (this.preCalculated[`${vt}-${es}-${ss}-${ts}-${os}-${is}`] = bs * _s / gs, bs * _s / gs) : 0
    }
    let ns, ls;
    vt === 0 ? ns = this.isCorners ? 1 / (corners(ss, 1, "under", "team", os === 100 ? "match" : "1H", this.coefficients) || 1 / 0) : poissonUnder(ss, 1) : ns = this.isCorners ? 1 / (corners(ss, vt, "exactly", "team", os === 100 ? "match" : "1H", this.coefficients) || 1 / 0) : poissonUnder(ss, vt + 1) - poissonUnder(ss, vt),
      es === 0 ? ls = this.isCorners ? 1 / (corners(ts, 1, "under", "team", os === 100 ? "match" : "1H", this.coefficients) || 1 / 0) : poissonUnder(ts, 1) : ls = this.isCorners ? 1 / (corners(ts, es, "exactly", "team", os === 100 ? "match" : "1H", this.coefficients) || 1 / 0) : poissonUnder(ts, es + 1) - poissonUnder(ts, es);
    let cs = ns * ls;
    return this.isDixonColes && os === 100 && (vt === 0 ? es === 0 ? cs *= 1 - ss * ts * this.rho : es === 1 && (cs *= 1 + ss * this.rho) : vt === 1 && (es === 0 ? cs *= 1 + ts * this.rho : es === 1 && (cs *= 1 - this.rho))),
      this.preCalculated[`${vt}-${es}-${ss}-${ts}-${os}-${is}`] = cs, cs
  }
}

// GameCentre — trimmed to the constructor + the "ahead at any point" methods (BB's class also
// carries ~100 other market methods that reference helpers we didn't lift; none are needed here).
class GameCentre {
  constructor(vt, es, ss, ts, os, is = !1, rs = null, ns = !1, ls = -.13) {
    this.homeXg = vt, this.awayXg = es, this.halfSplits = ss, this.splits = ts,
      this.bbCorrectScore = new BbCorrectScore(is, rs, os, ns, ls)
  }
  aheadAtAnyPointFractionForScoreline(vt, es) { if (vt === 0) return 0; if (vt > es) return 1; const { success: ss, total: ts } = this.aheadAtAnyPointPaths(0, 0, vt, es, vt); return ss / ts }
  aheadAtAnyPointPaths(vt, es, ss, ts, os, is = new Map) { const rs = `${vt},${es},${ss},${ts}`, ns = is.get(rs); if (ns !== void 0) return ns; if (vt > es) { const us = this.goalOrderings(ss + ts, ss), hs = { success: us, total: us }; return is.set(rs, hs), hs } if (es >= os) { const hs = { success: 0, total: this.goalOrderings(ss + ts, ss) }; return is.set(rs, hs), hs } if (ss === 0 && ts === 0) { const us = { success: 0, total: 1 }; return is.set(rs, us), us } let ls = 0, cs = 0; if (ss > 0) { const us = this.aheadAtAnyPointPaths(vt + 1, es, ss - 1, ts, os, is); ls += us.success, cs += us.total } if (ts > 0) { const us = this.aheadAtAnyPointPaths(vt, es + 1, ss, ts - 1, os, is); ls += us.success, cs += us.total } const ds = { success: ls, total: cs }; return is.set(rs, ds), ds }
  goalOrderings(vt, es) { if (es < 0 || es > vt) return 0; if (es === 0 || es === vt) return 1; const ss = Math.min(es, vt - es); let ts = 1; for (let os = 1; os <= ss; os++) ts = ts * (vt - ss + os) / os; return ts }
  teamAheadAtAnyPoint(vt, es, ss = !1, ts = !1) { if (vt === 1 / 0 || es === 1 / 0) return 1 / 0; let os = 0, is = 0, rs = basicGoals(is, es, "exactly"); for (; rs < 1e5 || is < es;) { for (let ns = 1; ; ns++) { const ls = ts ? this.bbCorrectScore.calculate(is, ns, es, vt, 100, ss) : this.bbCorrectScore.calculate(ns, is, vt, es, 100, ss); if (ls <= 1e-6 && ns >= vt) break; (ls > 1e-6 || ns < vt) && (os += ls * this.aheadAtAnyPointFractionForScoreline(ns, is)) } is++, rs = basicGoals(is, es, "exactly") } return 1 / os }
}

// Hand transcription of BB's inline `allCalculations` block that sets
// game.calculations.{homeTeamGoals,awayTeamGoals,homeTeamGoalsOther,awayTeamGoalsOther};
// goalsFromGame(game,"match","home") then returns homeTeamGoals || homeTeamGoalsOther.
function deriveTeamXg(game, config) {
  const lo = game.lineOverrides || false;
  const ts = {
    home: fairFromBetfair(game.home, false, lo ? lo.home : false),
    away: fairFromBetfair(game.away, false, lo ? lo.away : false),
    draw: fairFromBetfair(game.draw, false, lo ? lo.draw : false),
    gameXg: gameXg(game, false),
  };
  homeAwayPrices(ts);
  if (!ts.gameXg) return { homeXg: false, awayXg: false, total: false, source: 'no-gameXg' };

  const c = config.bbHomeAwayXg; // { a, b, x, y } from goals/config
  const sg = config.spreadGoals; // "mid"

  const ls = ts.home && ts.away
    ? normalizeTotal(bbTeamXg(ts.home, ts.away, c.a, c.b, c.x, c.y, ts.gameXg), bbTeamXg(ts.away, ts.home, c.a, c.b, c.x, c.y, ts.gameXg), ts.gameXg)
    : undefined;
  const ds = ts.home && ts.away
    ? normalizeTotal(bbTeamXg(ts.away, ts.home, c.a, c.b, c.x, c.y, ts.gameXg), bbTeamXg(ts.home, ts.away, c.a, c.b, c.x, c.y, ts.gameXg), ts.gameXg)
    : undefined;
  let cs = normalizeTotal(spreadMean(game, "home-team-goals", false, sg) || undefined, spreadMean(game, "away-team-goals", false, sg) || undefined, ts.gameXg);
  let us = normalizeTotal(spreadMean(game, "away-team-goals", false, sg) || undefined, spreadMean(game, "home-team-goals", false, sg) || undefined, ts.gameXg);
  if (!cs && us) cs = ts.gameXg - us;
  if (cs && !us) us = ts.gameXg - cs;

  let homeTeamGoals, awayTeamGoals, homeTeamGoalsOther, awayTeamGoalsOther;
  if (game.bbHomeAwayXg || game.bbHomeAwayXg === undefined || !us || !cs) {
    homeTeamGoals = (ts.home && ts.away && ls) || false;
    awayTeamGoals = (ts.home && ts.away && ds) || false;
    homeTeamGoalsOther = cs || false;
    awayTeamGoalsOther = us || false;
  } else {
    homeTeamGoals = cs;
    awayTeamGoals = us;
    homeTeamGoalsOther = (ts.home && ts.away && ls) || false;
    awayTeamGoalsOther = (ts.home && ts.away && ds) || false;
  }
  const homeXg = homeTeamGoals || homeTeamGoalsOther;
  const awayXg = awayTeamGoals || awayTeamGoalsOther;
  return {
    homeXg: homeXg || false,
    awayXg: awayXg || false,
    total: ts.gameXg,
    source: (homeTeamGoals ? 'bbTeamXg(1X2)' : (homeTeamGoalsOther ? 'spreadMean' : 'none')),
    homeFair: ts.home, awayFair: ts.away, drawFair: ts.draw,
  };
}

// method: "poisson" (default — pure independent Poisson, validated exact against BB),
//         "dixon_coles" (Poisson + low-score tau, rho -0.13),
//         "bb" (blends the feed's Betfair correct-score market — what BB's UI shows; approximate).
function leadAtAnyTime(game, config, method = 'poisson') {
  const xg = deriveTeamXg(game, config);
  if (!xg.homeXg || !xg.awayXg) return { ...xg, homeOdds: null, awayOdds: null };
  const csMarket = method === 'poisson' || method === 'dixon_coles' ? false : (game.correctScore || false);
  const isDC = method === 'dixon_coles';
  const gc = new GameCentre(xg.homeXg, xg.awayXg, [0, 0], [], csMarket, false, null, isDC, -0.13);
  const homeOdds = gc.teamAheadAtAnyPoint(xg.homeXg, xg.awayXg, true);
  const awayOdds = gc.teamAheadAtAnyPoint(xg.awayXg, xg.homeXg, true, true);
  return { ...xg, homeOdds: isFinite(homeOdds) ? homeOdds : null, awayOdds: isFinite(awayOdds) ? awayOdds : null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Player AGS — our own reverse-engineering (2026-09-09), verified to 3dp against BB's live
// Player xG "Standard" table. See module header for the two worked examples.
// ─────────────────────────────────────────────────────────────────────────────

function marginMultiplier(bbp) {
  let m = 1.15;
  if (bbp > 4) m = 1.25;
  if (bbp > 6) m = 1.35;
  if (bbp > 12) m = 1.52;
  return m;
}

// entry: one match.playerXg[name] object ({anytimeBbp, anytimeBookmakers, override, ...}).
// Mirrors playerAgs()'s bookmaker-count gate (below playerXgMinimumBookmakers → no price at all,
// same as BB showing nothing) — returns null rather than a misleadingly-thin-market number.
function rawXgFromPlayerXgEntry(entry, config) {
  if (!entry) return null;
  const minBooks = (config && config.playerXgMinimumBookmakers) || 3;
  if (entry.anytimeBookmakers == null || entry.anytimeBookmakers < minBooks) return null;
  if (entry.anytimeBbp == null || !isFinite(entry.anytimeBbp) || entry.anytimeBbp <= 1) return null;
  const fairPrice = entry.anytimeBbp * marginMultiplier(entry.anytimeBbp);
  return -Math.log(1 - 1 / fairPrice);
}

function agsFromXg(xg) {
  if (xg == null || !isFinite(xg) || xg <= 0) return null;
  return 1 / (1 - Math.exp(-xg));
}

// subPercentageForGame — verbatim logic, decoded 2026-09-09.
function subPercentageForGame(game, config) {
  if (!game || !game.competition) return config.subPercentage;
  if (game.competition.id && config.competitionSubPercentage) {
    const m = config.competitionSubPercentage.find(e => e.competition === game.competition.id);
    if (m) return m.subPercentage;
  }
  return config.subPercentage;
}

// Fuzzy player-name match — FotMob lineup names vs BB's playerXg keys. Small server-side twin of
// index.html's findPlayerInOddsList(): last name must match (or be a 1-char typo away), then at
// least one other word overlaps (or there's only a last name to go on).
function normPlayerName(n) {
  return (n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function findBbPlayerKey(fotmobName, playerXgKeys) {
  const na = normPlayerName(fotmobName);
  const wa = na.split(' ');
  const lastA = wa[wa.length - 1];
  const pairMatch = (a, b) => a.length >= 4 && b.length >= 4 && Math.abs(a.length - b.length) <= 1 && [...a].filter((c, i) => c !== b[i]).length <= 1;
  // A single-letter first-name token ("D." shown as "d" once punctuation is stripped) matches
  // any full first name starting with that letter ("Daniel") — FotMob often abbreviates to an
  // initial where BB spells the name out, so without this a name like "D. Banjaqui" never
  // matches "Daniel Banjaqui" at all (the plain pairMatch length>=4 floor excludes single letters
  // outright, and un-abbreviated first names never get compared).
  const initialMatch = (a, b) => (a.length === 1 && b.length >= 1 && b[0] === a) || (b.length === 1 && a.length >= 1 && a[0] === b);
  return playerXgKeys.find(key => {
    const nb = normPlayerName(key);
    if (na === nb) return true;
    const wb = nb.split(' ');
    const lastB = wb[wb.length - 1];
    const lastNamesMatch = lastA === lastB || pairMatch(lastA, lastB);
    if (!lastNamesMatch) return false;
    const firstA = wa.slice(0, -1), firstB = wb.slice(0, -1);
    if (!firstA.length || !firstB.length) return true;
    return firstA.some(w => firstB.some(b => b === w || pairMatch(w, b) || initialMatch(w, b)));
  }) || null;
}

const GK_RE = /goalkeeper|^gk$|^g$/i;

// The main entry point. match/config = raw goals/list & goals/config objects (or a single match
// from goals/list). starters = { home: [{name, position}], away: [{name, position}] } from OUR
// OWN FotMob lineup data (netlify/functions/lineups.js) — NOT BB's own lineup source — plus
// `confirmed` (FotMob's lineupType-derived confirmed flag). Returns one entry per BB playerXg
// name: { name, team, rawXg, rawAgs, normXg, ags, agsSource } where agsSource is
// 'post-lineup' (normalized against the confirmed XI) or 'pre-lineup' (raw market price only —
// always present whenever BB has enough bookmaker coverage, even before any lineup exists at
// all, which is more than BB's own page shows in that window: it requires ITS OWN confirmed
// lineup before showing anything at all, even the un-normalized price).
function computePlayerAgs(match, config, { homeStarters, awayStarters, confirmed } = {}) {
  const px = match.playerXg || {};
  const names = Object.keys(px).filter(n => n.toLowerCase() !== 'no goalscorer');

  const rawXgByName = {};
  for (const name of names) rawXgByName[name] = rawXgFromPlayerXgEntry(px[name], config);

  const out = {};
  for (const name of names) {
    const rawXg = rawXgByName[name];
    out[name] = {
      name, team: px[name].team,
      rawXg, rawAgs: agsFromXg(rawXg),
      normXg: null, ags: agsFromXg(rawXg), agsSource: rawXg != null ? 'pre-lineup' : null,
    };
  }
  if (!confirmed) return out;

  const teamXg = deriveTeamXg(match, config);
  if (!teamXg || !teamXg.homeXg || !teamXg.awayXg) return out;
  const subPct = subPercentageForGame(match, config);
  const ownGoalPct = (config && config.ownGoalPercentage) || 3.16;
  if (subPct == null) return out; // can't normalize without it — leave everyone on pre-lineup

  for (const [side, starters, teamGoals] of [['home', homeStarters, teamXg.homeXg], ['away', awayStarters, teamXg.awayXg]]) {
    if (!Array.isArray(starters) || starters.length < 10) continue; // need a real XI to normalize against
    const outfield = [];
    for (const p of starters) {
      if (GK_RE.test(p.position || '')) continue;
      const key = findBbPlayerKey(p.name, names);
      if (key && rawXgByName[key] != null) outfield.push(key);
    }
    if (outfield.length < 6) continue; // too few matched to trust the sum (thin BB coverage for this XI)
    const sumRawXg = outfield.reduce((s, k) => s + rawXgByName[k], 0);
    if (!(sumRawXg > 0)) continue;
    const factor = (teamGoals * (1 - ownGoalPct / 100)) / sumRawXg * (1 - subPct / 100);
    for (const key of outfield) {
      const normXg = rawXgByName[key] * factor;
      out[key].normXg = normXg;
      out[key].ags = agsFromXg(normXg);
      out[key].agsSource = 'post-lineup';
    }
  }
  return out;
}

module.exports = {
  // low-level (mostly for bb-lead.js / testing)
  takeStep, poissonUnder, poissonOver, basicGoals, bbTeamXg, normalizeTotal, confidence, gameXg,
  fairFromBetfair, homeAwayPrices, spreadMean, BbCorrectScore, GameCentre,
  // team-xG + lead-at-any-time
  deriveTeamXg, leadAtAnyTime,
  // player AGS
  marginMultiplier, rawXgFromPlayerXgEntry, agsFromXg, subPercentageForGame, findBbPlayerKey, computePlayerAgs,
};

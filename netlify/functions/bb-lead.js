// bb-lead.js — "Team to be leading at any time" fair odds, computed our side from
// BookieBashing's own goals/list feed (the same endpoint + BB_HASH / BB_COOKIES auth as
// bb-odds.js / ddhh.js — BB does NOT geo-fence, so this runs fine as a plain Netlify function;
// server.js also mounts it on the DO box). Feeds the Calculations > Freeze page.
//
// BookieBashing has NO endpoint that returns this market; its frontend computes it in the
// browser (Game Centre → "Home/Away To Be Ahead At Any Point"). Rather than drive a headless
// logged-in browser per fixture, the maths below is BookieBashing's OWN code, lifted verbatim
// from js/daily-goals/dist/assets/index-*.js (2026-09-08 build) so that if they change the
// model we re-lift rather than re-derive:
//   - class BbCorrectScore                       — scoreline probabilities (Poisson / Dixon-Coles
//                                                  / blended with the feed's Betfair CS market)
//   - GameCentre.teamAheadAtAnyPoint + helpers   — Σ P(scoreline) · P(led at some point | score)
//   - poissonUnder/Over, basicGoals              — Poisson pmf helpers
//   - gameXg, bbTeamXg, normalizeTotal,          — per-match Home xG / Away xG derivation
//     confidence, fairFromBetfair, spreadMean,     (1X2-fair-odds polynomial, coeffs from
//     singleSpreadMean, homeAwayPrices             goals/config.bbHomeAwayXg; spread-firm mean
//                                                  as the fallback), matching goalsFromGame()
//
// Verbatim bits keep BB's original identifiers (incl. the minifier's 1/0 for Infinity, !0/!1
// for true/false). `deriveTeamXg` is a hand transcription of the inline block in BB's Vue
// `allCalculations` method (it isn't a standalone function in their bundle) — the one part
// not copy-pasteable, flagged so a future mismatch is quick to find.
//
// Validated 2026-09-08 against BB's live Game Centre across all 7 upcoming EPL fixtures:
//   - method "poisson"      — matches BB to <0.006 on every fixture (xG split + odds both exact)
//   - method "dixon_coles"  — matches BB to <0.01
//   - method "bb" (blend)   — usually within ~1.5% but one fixture (sparse Betfair CS feed) was
//                             ~4% out; the hand-transcribed blend branch isn't a perfect copy.
// So the default here is "poisson" (deterministic, no dependency on CS-feed quality). BB's own
// UI defaults to "bb" and its three methods disagree by ~1.5% anyway — this is a modelling
// choice, not a single true price.

/* eslint-disable */
const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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

// ─────────────────────────────────────────────────────────────────────────────
// Hand transcription of BB's inline `allCalculations` block that sets
// game.calculations.{homeTeamGoals,awayTeamGoals,homeTeamGoalsOther,awayTeamGoalsOther};
// goalsFromGame(game,"match","home") then returns homeTeamGoals || homeTeamGoalsOther.
// ─────────────────────────────────────────────────────────────────────────────
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

  // ls = 1X2-fair-odds polynomial split (home value), normalised to total
  const ls = ts.home && ts.away
    ? normalizeTotal(
        bbTeamXg(ts.home, ts.away, c.a, c.b, c.x, c.y, ts.gameXg),
        bbTeamXg(ts.away, ts.home, c.a, c.b, c.x, c.y, ts.gameXg),
        ts.gameXg)
    : undefined;
  // ds = same split, away value
  const ds = ts.home && ts.away
    ? normalizeTotal(
        bbTeamXg(ts.away, ts.home, c.a, c.b, c.x, c.y, ts.gameXg),
        bbTeamXg(ts.home, ts.away, c.a, c.b, c.x, c.y, ts.gameXg),
        ts.gameXg)
    : undefined;
  // cs / us = spread-firm team-goals mean split (home / away)
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
// Feed fetch (same auth/pattern as bb-odds.js / ddhh.js)
// ─────────────────────────────────────────────────────────────────────────────
async function bbFetch(path) {
  const hash = process.env.BB_HASH, cookies = process.env.BB_COOKIES;
  if (!hash || !cookies) throw new Error('BB_HASH or BB_COOKIES not set');
  const res = await fetch(`https://www.bookiebashing.net/node/rest/${path}?t=${Math.floor(Date.now() / 1000)}`, {
    headers: {
      'User-Agent': UA, 'Cookie': cookies, 'X-BB-Hash': hash,
      'X-BB-User': 'user', 'X-BB-Userid': '11815', 'X-BB-Userlevel': '1',
      'Referer': 'https://www.bookiebashing.net/tools/daily/',
      'Origin': 'https://www.bookiebashing.net',
    },
  });
  const text = await res.text();
  if (text.trim().startsWith('<')) throw new Error('BB returned HTML — BB_HASH or BB_COOKIES may have expired');
  return JSON.parse(text);
}

// Split a BB "Home v Away" / "Home vs Away" event string into team names.
function splitEvent(ev) {
  const m = String(ev || '').split(/\s+vs?\s+/i);
  return m.length === 2 ? { homeName: m[0].trim(), awayName: m[1].trim() } : { homeName: '', awayName: '' };
}

// GET /api/bb-lead
//   (no params)                     — every football match in the feed (fairs null where BB has
//                                     no derivable team-xG split — the caller needs to tell that
//                                     apart from "not in the feed at all")
//   ?eventId=... | ?home=X&away=Y   — just that match
//   ?method=poisson|dixon_coles|bb  — model variant (default poisson)
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const { eventId, home, away, method } = event.queryStringParameters || {};
  try {
    const [list, config] = await Promise.all([bbFetch('goals/list'), bbFetch('goals/config')]);

    let games = list;
    if (eventId) games = list.filter(m => String(m.eventId ?? m.id ?? m._id) === String(eventId));
    else if (home && away) {
      const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
      const h = norm(home), a = norm(away);
      games = list.filter(m => { const e = norm(m.event); return e.includes(h.split(' ').pop()) && e.includes(a.split(' ').pop()); });
    }

    const matches = games
      .filter(g => g && g.event && /\s+vs?\s+/i.test(g.event))
      .map(g => {
        const r = leadAtAnyTime(g, config, method || 'poisson') || {};
        const { homeName, awayName } = splitEvent(g.event);
        return {
          eventId: g.eventId ?? g.id ?? g._id,
          event: g.event,
          homeName, awayName,
          competition: g.competition && g.competition.name || '',
          startTime: g.startTime || null,
          homeXg: r.homeXg || null,
          awayXg: r.awayXg || null,
          xgSource: r.source || null,
          homeLeadAnyTime: r.homeOdds || null,
          awayLeadAnyTime: r.awayOdds || null,
        };
      })
      .sort((x, y) => (x.startTime || 0) - (y.startTime || 0));

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, updated: new Date().toISOString(), method: method || 'poisson', count: matches.length, withFairs: matches.filter(m => m.homeLeadAnyTime && m.awayLeadAnyTime).length, matches }) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

// exported for local validation against BB's live Game Centre
exports._internal = { leadAtAnyTime, deriveTeamXg, GameCentre, BbCorrectScore };

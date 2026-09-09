// bb-lead.js — "Team to be leading at any time" fair odds, computed our side from
// BookieBashing's own goals/list feed (the same endpoint + BB_HASH / BB_COOKIES auth as
// bb-odds.js / ddhh.js — BB does NOT geo-fence, so this runs fine as a plain Netlify function;
// server.js also mounts it on the DO box). Feeds the Calculations > Freeze page.
//
// BookieBashing has NO endpoint that returns this market; its frontend computes it in the
// browser (Game Centre → "Home/Away To Be Ahead At Any Point"). Rather than drive a headless
// logged-in browser per fixture, the maths is BookieBashing's OWN code, lifted verbatim from
// js/daily-goals/dist/assets/index-*.js (2026-09-08 build) — see ../../bb-calc-lib.js (moved
// there 2026-09-09 so bb-odds.js's player-AGS calc can share the same team-xG derivation
// instead of a second hand-copy drifting out of sync) for the full provenance note and the
// verbatim BB code itself (class BbCorrectScore, GameCentre.teamAheadAtAnyPoint + helpers,
// poissonUnder/Over, basicGoals, gameXg, bbTeamXg, normalizeTotal, confidence, fairFromBetfair,
// spreadMean, homeAwayPrices, deriveTeamXg).
//
// Validated 2026-09-08 against BB's live Game Centre across all 7 upcoming EPL fixtures:
//   - method "poisson"      — matches BB to <0.006 on every fixture (xG split + odds both exact)
//   - method "dixon_coles"  — matches BB to <0.01
//   - method "bb" (blend)   — usually within ~1.5% but one fixture (sparse Betfair CS feed) was
//                             ~4% out; the hand-transcribed blend branch isn't a perfect copy.
// So the default here is "poisson" (deterministic, no dependency on CS-feed quality). BB's own
// UI defaults to "bb" and its three methods disagree by ~1.5% anyway — this is a modelling
// choice, not a single true price.

const { leadAtAnyTime } = require('../../bb-calc-lib');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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

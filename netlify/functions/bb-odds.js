// bb-odds.js — per-player BookieBashing fair odds for a fixture, feeding the "BookieBashing Fair
// Odds" strip on the Today's Matches player panel (index.html openPlayerStats/renderPlayerStats)
// and the mixed BFEX/BB fair-odds source used by the Header/OTB/GSM calculators.
//
// AGS (Anytime Goalscorer) is computed via our own reverse-engineered replica of BookieBashing's
// Player xG "Standard" table — see ../../bb-calc-lib.js for the full derivation/provenance note
// and computePlayerAgs(). Two modes, auto-selected per player:
//   - pre-lineup:  margin-removed market price -> Poisson conversion. Needs no lineup at all, so
//                  it's available the moment BB has enough bookmaker coverage — earlier than BB's
//                  OWN page, which shows nothing (not even this) until ITS OWN lineup source has
//                  confirmed a starting XI.
//   - post-lineup: normalized against a confirmed starting XI's combined raw xG and the match's
//                  team-goals split (deriveTeamXg) — matches BB's own "BB AGS" to ~3dp when it's
//                  showing one. Only kicks in when the caller supplies homeStarters/awayStarters
//                  (OUR OWN FotMob lineup data — see netlify/functions/lineups.js — not BB's).
// FGS and SOT are NOT upgraded yet (FGS needs BB's much heavier correct-score model; SOT needs
// separate reverse-engineering) — both still come straight off the raw feed, as before.

import bbCalcLib from '../../bb-calc-lib.js';
const { computePlayerAgs } = bbCalcLib;

export const handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const { eventId, home, away, homeStarters: homeStartersRaw, awayStarters: awayStartersRaw, confirmed, stats } = event.queryStringParameters || {};
  if (!eventId) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'eventId required' }) };
  const includeStatOdds = stats === '1' || stats === 'true';

  const hash    = process.env.BB_HASH;
  const cookies = process.env.BB_COOKIES;
  if (!hash || !cookies) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'BB_HASH or BB_COOKIES not set' }) };

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  let homeStarters = null, awayStarters = null;
  try { if (homeStartersRaw) homeStarters = JSON.parse(homeStartersRaw); } catch (e) { /* ignore malformed — falls back to pre-lineup */ }
  try { if (awayStartersRaw) awayStarters = JSON.parse(awayStartersRaw); } catch (e) { /* ignore malformed */ }
  const isConfirmed = confirmed === '1' || confirmed === 'true';

  // ── Name normalisation ─────────────────────────────────────────────────────
  function norm(n) {
    return (n || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function fuzzyMatch(a, b) {
    const na = norm(a), nb = norm(b);
    // Neither side should ever "match" an empty/missing comparand — without this, a caller
    // passing undefined (e.g. matchByTeams splitting on a separator that isn't actually
    // present, leaving one side undefined) hits every().every() on an empty filtered array,
    // which is vacuously true, so ANYTHING "matches" nothing. Caught live 2026-09-13: this
    // silently matched Coventry City v Brighton to an unrelated Busan IPark v Gimhae City
    // fixture, feeding zero-player BB data into the AGS fair combo with no error anywhere.
    if (!na || !nb) return false;
    if (na === nb) return true;
    const wa = na.split(' '), wb = nb.split(' ');
    const [shorter, longer] = wa.length <= wb.length ? [wa, nb] : [wb, na];
    if (shorter.filter(w => w.length > 1).every(w => longer.includes(w))) return true;
    // Near-match: catches Willian/William, Moseis/Moises etc (1 char difference)
    const pairMatch = (a, b) => a.length >= 4 && b.length >= 4 &&
      Math.abs(a.length - b.length) <= 1 &&
      [...a].filter((c, i) => c !== (b[i] || '')).length <= 1;
    return wa.some(a => wb.some(b => pairMatch(a, b))) &&
      wa.filter(w => w.length > 3).some(a => wb.some(b => pairMatch(a, b)));
  }

  // ── Match a BB event string against home/away team names ───────────────────
  // BB event strings look like: "Ecuador v Germany", "Man City vs Liverpool"
  function matchByTeams(bbEvent, homeTeam, awayTeam) {
    if (!bbEvent || !homeTeam || !awayTeam) return false;
    const e = norm(bbEvent);
    // Only split on a separator that's actually present — splitting on one that isn't gives
    // back the WHOLE untouched event string as "part 1", which then gets compared against a
    // single team name as if it were the other team's name. That's how "Coventry City" ended
    // up fuzzy-matching the full string "busan ipark v gimhae city": fuzzyMatch's near-match
    // check found "city" (shared with "Gimhae City") a "match" for the whole string, even
    // though "coventry" has nothing in common with any of it. Guarding on separator presence
    // stops the wrong half of the OR chain from ever running, on top of fuzzyMatch's own fix.
    const vParts = e.includes(' v ') ? e.split(' v ') : null;
    const vsParts = e.includes(' vs ') ? e.split(' vs ') : null;
    // Try both "home v away" and "away v home" orderings
    return (!!vParts && fuzzyMatch(homeTeam, vParts[0]) && fuzzyMatch(awayTeam, vParts[1])) ||
           (!!vParts && fuzzyMatch(awayTeam, vParts[0]) && fuzzyMatch(homeTeam, vParts[1])) ||
           // Also handle "vs" separator
           (!!vsParts && fuzzyMatch(homeTeam, vsParts[0]) && fuzzyMatch(awayTeam, vsParts[1])) ||
           (!!vsParts && fuzzyMatch(awayTeam, vsParts[0]) && fuzzyMatch(homeTeam, vsParts[1])) ||
           // Fallback: both team names appear somewhere in the event string
           (e.includes(norm(homeTeam).split(' ').pop()) && e.includes(norm(awayTeam).split(' ').pop()));
  }

  async function bbFetch(path) {
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(`https://www.bookiebashing.net/node/rest/${path}?t=${ts}`, {
      headers: {
        'User-Agent': UA,
        'Cookie': cookies,
        'X-BB-Hash': hash,
        'X-BB-User': 'user',
        'X-BB-Userid': '11815',
        'X-BB-Userlevel': '1',
        'Referer': 'https://www.bookiebashing.net/tools/daily/',
        'Origin': 'https://www.bookiebashing.net'
      }
    });
    const text = await res.text();
    if (text.trim().startsWith('<')) throw new Error('BB returned HTML — hash or cookies may have expired');
    return JSON.parse(text);
  }

  try {
    // config only actually needed once a confirmed lineup is supplied (it's an 11MB+ fetch) —
    // skip it otherwise, pre-lineup Raw AGS doesn't need it.
    const [list, config] = await Promise.all([
      bbFetch('goals/list'),
      isConfirmed && homeStarters && awayStarters ? bbFetch('goals/config') : Promise.resolve(null),
    ]);

    // ── Find the match ─────────────────────────────────────────────────────
    let match = list.find(m =>
      String(m.eventId) === String(eventId) ||
      String(m.id)      === String(eventId) ||
      String(m._id)     === String(eventId)
    );
    if (!match && home && away) {
      match = list.find(m => matchByTeams(m.event || m.name || m.eventName, home, away));
    }
    if (!match) return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: false,
      error: `Match not found in BB list (tried eventId ${eventId}${home ? ` and teams "${home}" vs "${away}"` : ''})`,
      available: list.slice(0, 15).map(m => ({ id: m.id || m._id, eventId: m.eventId, event: m.event || m.name || m.eventName })),
    })};

    // ── AGS: pre-lineup always, post-lineup (normalized) when a real config + confirmed XI
    // was supplied. computePlayerAgs itself falls back to pre-lineup per-player if the XI
    // doesn't have enough BB-matched names to trust the normalization — see bb-calc-lib.js.
    const agsByName = config
      ? computePlayerAgs(match, config, { homeStarters, awayStarters, confirmed: isConfirmed })
      : computePlayerAgs(match, null, {}); // config-less call still yields pre-lineup Raw AGS below

    // ── Build player odds map — FGS/SOT untouched (raw feed, as before); AGS upgraded ──────
    const playerOdds = {};
    const playerXg = match.playerXg || {};
    for (const [name, data] of Object.entries(playerXg)) {
      if (name === 'No Goalscorer') continue;
      const agsEntry = agsByName[name] || null;
      playerOdds[name] = {
        name,
        fgs: data.firstBbp || null,
        ags: agsEntry ? agsEntry.ags : (data.anytimeBbp || null), // last-ditch fallback if computePlayerAgs somehow skipped this name
        agsRaw: agsEntry ? agsEntry.rawAgs : null,
        agsSource: agsEntry ? agsEntry.agsSource : null,
        bfexAgs: data.anytimeExchange?.back || null,
        sot: null,
      };
    }

    const sots = match.sots || [];
    for (const entry of sots) {
      const sotName = entry.selection?.name;
      const sotBack = entry.back;
      if (!sotName || !sotBack) continue;
      const matchedKey = Object.keys(playerOdds).find(k => fuzzyMatch(k, sotName));
      if (matchedKey) {
        if (!playerOdds[matchedKey].sot || sotBack < playerOdds[matchedKey].sot)
          playerOdds[matchedKey].sot = sotBack;
      } else {
        playerOdds[sotName] = playerOdds[sotName] || { name: sotName, fgs: null, ags: null, agsRaw: null, agsSource: null, bfexAgs: null, sot: sotBack };
        if (!playerOdds[sotName].sot || sotBack < playerOdds[sotName].sot)
          playerOdds[sotName].sot = sotBack;
      }
    }

    // ── Optional (stats=1): per-player, per-bookmaker "Over 0.5" odds for Shots on Target and
    // Assists, straight off BB's playerStatsData block. Feeds the oc-scraper's own
    // BB-stage-1 devig (bb_stat_fair.py) + BB/OC combo fair — the raw numbers only, no
    // model applied here. playerStatsData is keyed [bookmakerName][playerName].
    if (includeStatOdds && match.playerStatsData) {
      const psd = match.playerStatsData;
      const byName = {}; // normalised BB name -> { sot:{book:odds}, assist:{book:odds}, name }
      for (const [book, players] of Object.entries(psd)) {
        for (const [pName, rec] of Object.entries(players || {})) {
          if (!rec) continue;
          const key = norm(pName);
          const slot = byName[key] || (byName[key] = { name: pName, sot: {}, assist: {} });
          if (rec.overSot && rec.overSot.odds) slot.sot[book] = rec.overSot.odds;
          if (rec.overAssists && rec.overAssists.odds) slot.assist[book] = rec.overAssists.odds;
        }
      }
      // attach onto the matching playerOdds entry; create a bare one if BB only has stat odds.
      for (const slot of Object.values(byName)) {
        const matchedKey = Object.keys(playerOdds).find(k => fuzzyMatch(k, slot.name));
        const target = matchedKey
          ? playerOdds[matchedKey]
          : (playerOdds[slot.name] = { name: slot.name, fgs: null, ags: null, agsRaw: null, agsSource: null, bfexAgs: null, sot: null });
        target.statOdds = { sot: slot.sot, assist: slot.assist };
      }
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: true,
      eventId,
      event: match.event || match.name || match.eventName,
      agsMode: config ? 'post-lineup-eligible' : 'pre-lineup-only',
      hasStatOdds: includeStatOdds && !!match.playerStatsData,
      players: Object.values(playerOdds)
    })};

  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

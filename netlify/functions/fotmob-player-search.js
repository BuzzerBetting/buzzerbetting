// netlify/functions/fotmob-player-search.js
//
// 2026-09-24, user-requested — the "Player finder" calculator (index.html Calculators hub)
// needs to look up a player who isn't in any fetched match lineup yet (no confirmed/predicted
// lineup published for their fixture), so it can't reuse the lineup-derived player list every
// other player-facing tool in this app relies on. Fotmob's own public search-suggest API is a
// plain unauthenticated fetch, confirmed live 2026-09-24, and already normalizes accents on the
// query side — searching the unaccented "hojlund"/"mbappe"/"gundogan" correctly found
// "Højlund"/"Mbappé"/"Gündogan" — so no fuzzy-matching layer is needed here beyond what Fotmob
// already does.
//
// GET ?term=<name> (surname alone is fine, e.g. "silva" — Fotmob's own relevance ranking and a
//   short results cap handle disambiguation, same reason the frontend shows a clickable list
//   rather than auto-picking the top hit).
// Returns { ok, results: [{ id, name, teamId, teamName }] } — coaches filtered out (this tool
// only ever wants a player to price shot markets for). `id` is Fotmob's own player id, the same
// id /api/player-stats and oc-scraper's lineup_stats.fetch_player_stats already key off.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const FOTMOB_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.fotmob.com/'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const term = (event.queryStringParameters || {}).term;
  if (!term || !term.trim()) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'term required' }) };

  try {
    const url = `https://apigw.fotmob.com/searchapi/suggest?term=${encodeURIComponent(term.trim())}&lang=en`;
    const res = await fetch(url, { headers: FOTMOB_HEADERS });
    if (!res.ok) throw new Error(`Fotmob search returned HTTP ${res.status}`);
    const data = await res.json();
    const options = (data.squadMemberSuggest || []).flatMap(g => g.options || []);
    const results = options
      .filter(o => !(o.payload || {}).isCoach)
      .map(o => {
        // o.text is "Full Name|<id>" — the id is also in payload.id, but text's own suffix is
        // the documented/observed shape, so parse both and prefer payload.id if it disagrees.
        const name = (o.text || '').split('|')[0].trim();
        const id = (o.payload || {}).id || (o.text || '').split('|')[1];
        return { id, name, teamId: (o.payload || {}).teamId ?? null, teamName: (o.payload || {}).teamName || '' };
      })
      .filter(r => r.id && r.name);

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, results }) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

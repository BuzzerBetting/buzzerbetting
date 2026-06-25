const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Referer': 'https://www.oddschecker.com/',
  'Cache-Control': 'no-cache'
};

// FotMob league name → Oddschecker competition path
const COMP_MAP = {
  'premier league':         'english/premier-league',
  'championship':           'english/championship',
  'fa cup':                 'english/fa-cup',
  'efl cup':                'english/league-cup',
  'champions league':       'champions-league',
  'europa league':          'europa-league',
  'conference league':      'europa-conference-league',
  'world cup':              'world-cup',
  'nations league':         'nations-league',
  'euros':                  'european-championship',
  'euro':                   'european-championship',
  'la liga':                'spanish/la-liga',
  'bundesliga':             'german/bundesliga',
  '2. bundesliga':          'german/2-bundesliga',
  'serie a':                'italian/serie-a',
  'ligue 1':                'french/ligue-1',
  'eredivisie':             'dutch/eredivisie',
  'primeira liga':          'portuguese/primeira-liga',
  'scottish premiership':   'scottish/premiership',
  'mls':                    'usa/major-league-soccer',
};

const MARKETS = [
  { key: 'header',    label: 'Header Scorer',       slug: 'to-score-a-header' },
  { key: 'otb',       label: 'Score Outside Box',   slug: 'to-score-from-outside-penalty-box' },
  { key: 'headedSOT', label: 'Headed SOT',          slug: 'player-headed-shots-on-target' },
  { key: 'otbSOT',    label: 'SOT Outside Box',     slug: 'player-shots-on-target-outside-box' },
];

function slugify(str) {
  return (str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function getCompSlug(competition) {
  const c = (competition || '').toLowerCase().trim();
  for (const [key, val] of Object.entries(COMP_MAP)) {
    if (c.includes(key)) return val;
  }
  // Fallback: just slugify the competition name
  return slugify(competition);
}

// Parse OC HTML for odds table
// OC uses data-o for decimal odds, data-bname on rows for selection names
function parseOCHtml(html) {
  const players = [];

  // Try to find selections in the table
  // Pattern: data-bname="Player Name" ... data-best="21.00"
  const rowRegex = /data-bname="([^"]+)"[^>]*>([\s\S]*?)(?=data-bname=|<\/tbody>)/g;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const name = rowMatch[1].trim();
    const rowHtml = rowMatch[2];
    // Find best price in this row
    const bestMatch = rowHtml.match(/data-best="([\d.]+)"/);
    if (bestMatch) {
      players.push({ name, best: parseFloat(bestMatch[1]) });
    }
  }

  if (players.length) return players;

  // Fallback: try simpler data-o pattern
  // Look for <tr> rows with selection name + best odds
  const trRegex = /<tr[^>]*class="[^"]*diff-row[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;
  let trMatch;
  while ((trMatch = trRegex.exec(html)) !== null) {
    const rowHtml = trMatch[1];
    // Selection name
    const nameMatch = rowHtml.match(/class="[^"]*sel-name[^"]*"[^>]*>([^<]+)</) ||
                      rowHtml.match(/class="[^"]*selLink[^"]*"[^>]*>([^<]+)</);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    // Best odds
    const bestMatch = rowHtml.match(/data-best="([\d.]+)"/) ||
                      rowHtml.match(/class="[^"]*best[^"]*"[^>]*data-o="([\d.]+)"/);
    if (bestMatch) {
      players.push({ name, best: parseFloat(bestMatch[1]) });
    }
  }

  if (players.length) return players;

  // Last resort: try to find JSON data embedded in page
  const jsonMatch = html.match(/"selections"\s*:\s*(\[[\s\S]+?\])/);
  if (jsonMatch) {
    try {
      const sels = JSON.parse(jsonMatch[1]);
      sels.forEach(s => {
        if (s.name && s.bestPrice) players.push({ name: s.name, best: s.bestPrice });
      });
    } catch (e) {}
  }

  return players;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const { home, away, competition } = event.queryStringParameters || {};
  if (!home || !away) return {
    statusCode: 200, headers: CORS,
    body: JSON.stringify({ ok: false, error: 'home and away required' })
  };

  const compSlug = getCompSlug(competition);
  const matchSlug = `${slugify(home)}-v-${slugify(away)}`;
  const baseUrl = `https://www.oddschecker.com/football/${compSlug}/${matchSlug}`;

  const results = await Promise.allSettled(
    MARKETS.map(async (market) => {
      const url = `${baseUrl}/${market.slug}/winner`;
      try {
        const res = await fetch(url, { headers: HEADERS });
        const html = await res.text();

        // Check if we got blocked or a redirect
        if (res.status === 404) return { ...market, players: [], error: '404 — market not found on OC' };
        if (res.status !== 200) return { ...market, players: [], error: `HTTP ${res.status}` };
        if (html.includes('Access Denied') || html.includes('captcha')) {
          return { ...market, players: [], error: 'OC blocked request' };
        }

        const players = parseOCHtml(html);
        return { ...market, url, players };
      } catch (err) {
        return { ...market, players: [], error: err.message };
      }
    })
  );

  const markets = results.map(r => r.status === 'fulfilled' ? r.value : { ...r.reason, players: [] });
  const totalPlayers = markets.reduce((t, m) => t + m.players.length, 0);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      match: `${home} v ${away}`,
      baseUrl,
      totalPlayers,
      markets
    })
  };
};

// netlify/functions/betfred.js
// Fetches a Betfred event page and parses player SOT OTB odds from the HTML text

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Referer': 'https://www.google.com/',
};

function fracToDecimal(num, den) {
  return parseFloat(((num / den) + 1).toFixed(3));
}

// Parse player odds from Betfred page text
// Format: "Surname, Firstname\nX/Y\n"
function parsePlayerOdds(text, marketHeading) {
  const players = [];

  // Find the market section
  const startIdx = text.indexOf(marketHeading);
  if (startIdx === -1) return players;

  // Find the next market heading or end of relevant section
  const nextMarket = text.indexOf('\nPlayer', startIdx + marketHeading.length);
  const section = nextMarket === -1
    ? text.slice(startIdx + marketHeading.length)
    : text.slice(startIdx + marketHeading.length, nextMarket);

  // Match "Surname, Firstname\nX/Y" pattern
  const lines = section.split('\n').map(l => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const nameLine = lines[i];
    const oddsLine = lines[i + 1];

    // Name line: contains a comma (Surname, Firstname format)
    if (!nameLine.includes(',')) continue;
    // Odds line: fraction format X/Y
    if (!oddsLine || !/^\d+\/\d+$/.test(oddsLine)) continue;

    // Convert "Surname, Firstname" to "Firstname Surname"
    const parts = nameLine.split(',').map(p => p.trim());
    const name = parts.length === 2 ? `${parts[1]} ${parts[0]}` : nameLine;

    const [num, den] = oddsLine.split('/').map(Number);
    if (!num || !den) continue;

    const dec = fracToDecimal(num, den);
    players.push({ name, odds: oddsLine, decimal: dec });
    i++; // skip odds line
  }

  return players.sort((a, b) => a.decimal - b.decimal);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const { eventId, market } = event.queryStringParameters || {};

  if (!eventId) {
    return {
      statusCode: 400, headers: CORS,
      body: JSON.stringify({ ok: false, error: 'eventId required (Betfred event ID)' })
    };
  }

  const marketParam = market || 'shots';
  const url = `https://www.betfred.com/sports/football/event/${eventId}?marketGroupsTab=${marketParam}`;

  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) {
      return {
        statusCode: 502, headers: CORS,
        body: JSON.stringify({ ok: false, error: `Betfred page ${res.status}` })
      };
    }

    const html = await res.text();

    // Extract innerText-like content — Betfred renders odds in __NEXT_DATA__ or visible text
    // Try to find the structured data first
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);

    let pageText = '';
    if (nextDataMatch) {
      try {
        const nextData = JSON.parse(nextDataMatch[1]);
        // Try to get page text from Next.js data
        pageText = JSON.stringify(nextData);
      } catch(e) {}
    }

    // Also try extracting from visible HTML
    const bodyMatch = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                          .replace(/<style[\s\S]*?<\/style>/gi, '')
                          .replace(/<[^>]+>/g, '\n')
                          .replace(/&amp;/g, '&')
                          .replace(/&nbsp;/g, ' ')
                          .replace(/\n{3,}/g, '\n\n');

    const MARKETS = [
      {
        key: 'sot_otb',
        label: 'SOT Outside Box',
        heading: 'Player to Have 1 or More Shots on Target From Outside the Box'
      },
      {
        key: 'sot',
        label: 'Shots On Target',
        heading: 'Player 1+ Shots On Target (Sub Switch)'
      },
      {
        key: 'shots',
        label: 'Shots',
        heading: 'Player 1+ Shots (Sub Switch)'
      }
    ];

    const markets = {};
    for (const mkt of MARKETS) {
      markets[mkt.key] = parsePlayerOdds(bodyMatch, mkt.heading);
    }

    const total = Object.values(markets).reduce((n, arr) => n + arr.length, 0);

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: true,
        eventId,
        url,
        total,
        markets
      })
    };

  } catch (err) {
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};

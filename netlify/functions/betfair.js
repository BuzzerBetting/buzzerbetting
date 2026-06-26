// netlify/functions/betfair.js
// Fetches player market odds from Betfair Exchange

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const BFEX_ENDPOINT = 'https://api.betfair.com/exchange/betting/json-rpc/v1/';

const TARGET_MARKETS = [
  'PLAYER_TO_SCORE_OUTSIDE_BOX',
  'SHOT_ON_TARGET_OUTSIDE_BOX',
  'HEADER_SCORER',
  'HEADED_SHOT_ON_TARGET',
];

async function bfCall(method, params, appKey, session) {
  const res = await fetch(BFEX_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Application': appKey,
      'X-Authentication': session,
    },
    body: JSON.stringify([{
      jsonrpc: '2.0',
      method: `SportsAPING/v1.0/${method}`,
      params,
      id: 1
    }])
  });
  const data = await res.json();
  if (data[0]?.error) throw new Error(JSON.stringify(data[0].error));
  return data[0]?.result;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const appKey = process.env.BFEX_APP_KEY;
  const session = process.env.BFEX_SESSION;

  if (!appKey || !session) return {
    statusCode: 200, headers: CORS,
    body: JSON.stringify({ ok: false, error: 'BFEX_APP_KEY or BFEX_SESSION not set' })
  };

  const { home, away } = event.queryStringParameters || {};
  if (!home || !away) return {
    statusCode: 400, headers: CORS,
    body: JSON.stringify({ ok: false, error: 'home and away required' })
  };

  try {
    // Step 1: Find the event
    const events = await bfCall('listEvents', {
      filter: {
        eventTypeIds: ['1'], // Football
        textQuery: `${home} v ${away}`,
      }
    }, appKey, session);

    if (!events?.length) return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: false, error: `Event not found: ${home} v ${away}` })
    };

    const eventId = events[0].event.id;

    // Step 2: Find player markets for this event
    const catalogue = await bfCall('listMarketCatalogue', {
      filter: {
        eventIds: [eventId],
        marketTypeCodes: TARGET_MARKETS,
      },
      marketProjection: ['RUNNER_DESCRIPTION', 'MARKET_NAME'],
      maxResults: 50
    }, appKey, session);

    if (!catalogue?.length) return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: false, error: 'No player markets found', eventId })
    };

    // Step 3: Get market books (live prices)
    const marketIds = catalogue.map(m => m.marketId);
    const books = await bfCall('listMarketBook', {
      marketIds,
      priceProjection: { priceData: ['EX_BEST_OFFERS'] },
      orderProjection: 'EXECUTABLE',
      currencyCode: 'GBP'
    }, appKey, session);

    // Step 4: Combine catalogue + book data
    const marketMap = {};
    for (const m of catalogue) marketMap[m.marketId] = m;

    const markets = {};
    for (const book of (books || [])) {
      const meta = marketMap[book.marketId];
      if (!meta) continue;
      const marketType = meta.marketType || meta.description?.marketType || '';
      const key = marketType.toLowerCase();

      const players = [];
      for (const runner of (book.runners || [])) {
        if (runner.status !== 'ACTIVE') continue;
        // Find runner name from catalogue
        const runnerMeta = meta.runners?.find(r => r.selectionId === runner.selectionId);
        const name = runnerMeta?.runnerName ?? `Runner ${runner.selectionId}`;
        const bestBack = runner.ex?.availableToBack?.[0]?.price ?? null;
        if (!bestBack) continue;
        players.push({ name, price: bestBack, selectionId: runner.selectionId });
      }

      players.sort((a, b) => a.price - b.price);
      markets[key] = { marketId: book.marketId, marketName: meta.marketName, players };
    }

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: true,
        eventId,
        match: `${home} v ${away}`,
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

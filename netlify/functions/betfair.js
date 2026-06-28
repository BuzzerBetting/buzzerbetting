// netlify/functions/betfair.js
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};
const BFEX_BASE = 'https://api.betfair.com/exchange/betting/rest/v1.0';

async function bfCall(method, params, appKey, session) {
  const res = await fetch(`${BFEX_BASE}/${method}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Application': appKey,
      'X-Authentication': session,
      'Accept': 'application/json',
    },
    body: JSON.stringify(params)
  });
  const text = await res.text();
  if (text.trim().startsWith('<')) throw new Error('SESSION_EXPIRED');
  const data = JSON.parse(text);
  if (data.faultcode) throw new Error(data.faultstring || JSON.stringify(data));
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const appKey = process.env.BFEX_APP_KEY;
  if (!appKey) return {
    statusCode: 200, headers: CORS,
    body: JSON.stringify({ ok: false, error: 'BFEX_APP_KEY not set' })
  };

  const { home, away, session } = event.queryStringParameters || {};

  if (!session) return {
    statusCode: 200, headers: CORS,
    body: JSON.stringify({ ok: false, error: 'SESSION_MISSING' })
  };

  if (!home || !away) return {
    statusCode: 400, headers: CORS,
    body: JSON.stringify({ ok: false, error: 'home and away required' })
  };

  try {
    const events = await bfCall('listEvents', {
      filter: { eventTypeIds: ['1'], textQuery: `${home} v ${away}` }
    }, appKey, session);

    if (!events?.length) return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: false, error: `Event not found: ${home} v ${away}` })
    };

    const eventId = events[0].event.id;

    const catalogue = await bfCall('listMarketCatalogue', {
      filter: { eventIds: [eventId], marketTypeCodes: ['TO_SCORE', 'SHOTS_ON_TARGET_P1'] },
      marketProjection: ['RUNNER_DESCRIPTION', 'MARKET_NAME'],
      maxResults: 10
    }, appKey, session);

    if (!catalogue?.length) return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: false, error: 'No markets found', eventId })
    };

    const marketIds = catalogue.map(m => m.marketId);
    const books = await bfCall('listMarketBook', {
      marketIds,
      priceProjection: { priceData: ['EX_BEST_OFFERS'] },
    }, appKey, session);

    const marketMap = {};
    for (const m of catalogue) marketMap[m.marketId] = m;
    const markets = {};
    for (const book of (books || [])) {
      const meta = marketMap[book.marketId];
      if (!meta) continue;
      const players = [];
      for (const runner of (book.runners || [])) {
        if (runner.status !== 'ACTIVE') continue;
        const runnerMeta = meta.runners?.find(r => r.selectionId === runner.selectionId);
        const name = runnerMeta?.runnerName ?? `Runner ${runner.selectionId}`;
        const bestBack = runner.ex?.availableToBack?.[0]?.price ?? null;
        const lastTraded = runner.lastPriceTraded ?? null;
        players.push({ name, back: bestBack, lastTraded });
      }
      players.sort((a, b) => (a.back||999) - (b.back||999));
      markets[meta.marketName] = { marketId: book.marketId, players };
    }

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: true, eventId, markets })
    };

  } catch (err) {
    const expired = err.message === 'SESSION_EXPIRED';
    return {
      statusCode: expired ? 200 : 500, headers: CORS,
      body: JSON.stringify({ ok: false, error: err.message, sessionExpired: expired })
    };
  }
};

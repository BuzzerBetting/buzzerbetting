// netlify/functions/betfair.js
const https = require('https');
const http = require('http');
const url = require('url');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};
const BFEX_BASE = 'https://api.betfair.com/exchange/betting/rest/v1.0';

function proxyFetch(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const fixieUrl = process.env.FIXIE_URL;
    const target = new url.URL(targetUrl);
    
    let reqOptions;
    
    if (fixieUrl) {
      const proxy = new url.URL(fixieUrl);
      const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
      reqOptions = {
        hostname: proxy.hostname,
        port: proxy.port || 80,
        path: targetUrl, // full URL as path when using proxy
        method: options.method || 'GET',
        headers: {
          ...options.headers,
          'Host': target.hostname,
          'Proxy-Authorization': `Basic ${auth}`,
        }
      };
    } else {
      reqOptions = {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: options.method || 'GET',
        headers: options.headers || {}
      };
    }

    const protocol = fixieUrl ? http : https;
    const req = protocol.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, text: () => Promise.resolve(data), json: () => Promise.resolve(JSON.parse(data)) }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function getSessionToken(appKey) {
  const username = process.env.BFEX_USERNAME;
  const password = process.env.BFEX_PASSWORD;
  if (!username || !password) throw new Error('BFEX_USERNAME or BFEX_PASSWORD not set');
  const res = await proxyFetch('https://identitysso-cert.betfair.com/api/certlogin', {
    method: 'POST',
    headers: {
      'X-Application': appKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
  });
  const text = await res.text();
  console.log('Login response:', text.substring(0, 200));
  let data;
  try { data = JSON.parse(text); }
  catch(e) { throw new Error('Login returned non-JSON: ' + text.substring(0, 200)); }
  if (data.loginStatus !== 'SUCCESS') throw new Error(`Login failed: ${data.loginStatus}`);
  return data.sessionToken;
}

async function bfCall(method, params, appKey, session) {
  const res = await proxyFetch(`${BFEX_BASE}/${method}/`, {
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
  console.log(`[BF] ${method} status:${res.status} body:`, text.substring(0, 300));
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

  const { home, away } = event.queryStringParameters || {};
  if (!home || !away) return {
    statusCode: 400, headers: CORS,
    body: JSON.stringify({ ok: false, error: 'home and away required' })
  };

  try {
    const session = await getSessionToken(appKey);

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

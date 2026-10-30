// Server-side Bet Alerts -> Discord notifier (2026-10-27, Dan's spec).
//
// Runs inside server.js on the DO box, so alerts go out whether or not anyone has the site
// open. Every minute: rebuild what each Bet Alerts tab currently lists (same feeds the browser
// reads — the /api/* routes on this box and the ledger DB — and the same filters each tab's
// render applies), then for every user who has saved a Discord webhook and switched that tab
// on, post any bet that wasn't there before.
//
// Per webhook (a user can save two — slot 1 / slot 2, each with its own tabs), per tab:
//   - first look after the tab is switched on (or a webhook is saved) seeds silently, so turning
//     it on doesn't dump everything already listed;
//   - a bet posts once (key: tab + match + market + selection + bookmaker) and only re-posts if
//     its odds move 2%+ or its EV moves 2+ points from what was last posted;
//   - a bet the user has ticked as placed never posts;
//   - the sent list forgets anything that's been off the feed since before London midnight.
//
// Browser-only preferences (fairs source, Early Prices min EV / markets / "landed in last 5",
// Outliers market ticks, Grosvenor hide-under-2.5) can't be read here, so each tab uses its
// defaults: blend fair, Early Prices EV >= 10% with "landed in last 5" on, every market on.
// DDHH isn't covered (its prices only exist after a manual per-match Scan in the browser).
//
// Discord limits: up to 10 embeds per message, at most MAX_MSGS_PER_MIN messages a minute per
// webhook (the rest wait in the queue), 429 -> wait retry_after and retry. 401/403/404 means the
// webhook was deleted: it's marked dead (shown in the Notifications panel) and nothing more is
// sent until a working URL is saved.
//
// Keep the book-name tables and filter rules below in sync with index.html (BA_BOOK_ALIASES,
// OC_BOOKIE_NAMES, BOOKIES_LIST, baBookEnabled, calcEvMinPct, epVisible, ...).

const db = require('./ledger-db');

const PORT = process.env.PORT || 3000;
const BASE = `http://localhost:${PORT}`;
const TICK_MS = 60000;
const FIRST_RUN_DELAY_MS = 20000;
const MAX_MSGS_PER_MIN = 4;
const EMBEDS_PER_MSG = 10;
const MAX_QUEUE = 300;               // per webhook; oldest dropped past this
const ODDS_MOVE = 0.02;              // re-post when odds move 2%+ ...
const EV_MOVE_PTS = 2;               // ... or EV moves 2+ points
const PLACED_LOOKBACK = '-3 days';   // same as ledger-routes BET_PLACED_LOOKBACK
const OC_COVERAGE_IGNORE_WINDOW = '-12 hours';

// Tabs that can post, in tab order (index.html BA_EDGES minus DDHH / Corners).
const DISCORD_EDGES = {
  'oc-ev': 'Normal +EV', 'calc-ev': 'Calculated +EV', 'watch': 'Ones to Watch', 'early': 'Early Prices',
  'f1-ew': 'F1 EW', 'arbs': 'Arbs', 'dnf': 'DNFs', 'nfl-td': 'NFL TDs', 'errors': 'Errors',
  'unmatched': 'OC Coverage', 'outliers': 'Outliers', 'grosvenor': 'Grosvenor',
};
const EDGE_COLOR = {
  'oc-ev': 0x16a34a, 'calc-ev': 0x0ea5e9, 'watch': 0x8b5cf6, 'early': 0xf59e0b, 'f1-ew': 0xe11d48,
  'arbs': 0x14b8a6, 'dnf': 0x64748b, 'nfl-td': 0x2563eb, 'errors': 0xdc2626, 'unmatched': 0x94a3b8,
  'outliers': 0xd946ef, 'grosvenor': 0x0f766e,
};

// ---- small helpers ----
function londonDay(d = new Date()) { return d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' }); }
// Same normaliser as ledger-routes betAlertNorm / index.html baPlacedNorm.
function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function betKey(b) { return [norm(b.match), norm(b.market), norm(b.selection)].join(' | '); }
function num(v) { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : null; }

// Kickoff as a timestamp — feeds give London-local 'YYYY-MM-DD' + 'HH:MM', and this box runs on UTC.
function londonOffsetMs(ts) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ts)).reduce((o, x) => (o[x.type] = x.value, o), {});
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(ts / 60000) * 60000;
}
function kickoffTs(d, t) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) || !/^\d{1,2}:\d{2}$/.test(String(t || ''))) return null;
  const [Y, M, D] = d.split('-').map(Number);
  const [h, m] = String(t).split(':').map(Number);
  const guess = Date.UTC(Y, M - 1, D, h, m);
  return guess - londonOffsetMs(guess);
}
function kickoffPassed(d, t) {
  const ts = kickoffTs(d, t);
  return ts != null && ts <= Date.now();
}

// ---- bookmaker filter (index.html baResolveBook / baBookEnabled) ----
const OC_BOOKIE_NAMES = {
  B3:'Bet365', SK:'Sky Bet', WH:'William Hill', LD:'Ladbrokes', CE:'Coral', PP:'Paddy Power',
  BY:'BoyleSports', VC:'BetVictor', UN:'Unibet', FR:'Betfred', FB:'Betfred', EE:'888sport',
  WA:'BetWay', KN:'BetMGM', QN:'QuinnBet', OE:'10bet', S6:'Star Sports', PUP:'PricedUp',
  G5:'BetGoodwin', AKB:'AK Bets', BAH:'BetAhoy', BTT:'BetTom', IVB:'IvyBet', SI:'Sporting Index',
  SX:'Spreadex', BF:'Betfair', MA:'Matchbook', DZ:'DAZN Bet', KW:'Kwiff', NB:'NetBet',
  '32':'32Red', MK:'Midnite', FS:'FansBet', TF:'TheFA', RM:'MrQ', GB:'Grosvenor',
};
function bookName(code) {
  if (code == null) return '';
  const c = String(code).trim();
  return OC_BOOKIE_NAMES[c] || OC_BOOKIE_NAMES[c.toUpperCase()] || c;
}
const BA_BOOK_ALIASES = {
  'sky bet':'SkyBet','skybet':'SkyBet','paddy power':'PaddyPower','paddypower':'PaddyPower',
  'william hill':'WilliamHill','will hill':'WilliamHill','willhill':'WilliamHill',
  'bet 365':'Bet365','betfair sportsbook':'Betfair','betfair sb':'Betfair','betfair exchange':'Betfair',
  'betfair':'Betfair','888 sport':'888Sport','888sport':'888Sport','32 red':'32Red','32red':'32Red',
  'planet sport bet':'PlanetSportBet','planetsport bet':'PlanetSportBet','dazn bet':'DaznBet',
  'sporting bet':'SportingBet','sportingbet':'SportingBet','net bet':'NetBet','netbet':'NetBet',
  'star sports':'StarSportsBet','star sports bet':'StarSportsBet','priced up':'PricedUp',
  'pricedup':'PricedUp','dragon bet':'DragonBet','dragonbet':'DragonBet','bet george':'Bet StGeorge',
  'bet st george':'Bet StGeorge','mr q':'MrQ','mrq':'MrQ',
};
const BOOKIES_LIST = [
  'PricedUp','StarSportsBet','Bet StGeorge','Bet365','SkyBet','PaddyPower','Betfair','Betfred','SportingBet','PlanetSportBet','DragonBet','BestOdds','ProperBet','Fairplay','NRGBet','BetWay','888Sport','HotStreak','Midnite','NetBet','32Red','DaznBet','Fitzdares','Matchbook','Kwiff','MrQ','Lottoland','HighBet','ArrowBet','FairPlay','247Bet','DreamVegas','WilliamHill','LadBet',
];
const normBookKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function resolveBook(bk) {
  const raw = bookName(bk).trim();
  if (!raw) return null;
  const low = raw.toLowerCase();
  if (BA_BOOK_ALIASES[low]) return BA_BOOK_ALIASES[low];
  const nk = normBookKey(raw);
  return BOOKIES_LIST.find(b => normBookKey(b) === nk) || raw;
}
function makeBookFilter() {
  const books = {};
  for (const r of db.prepare(`SELECT bookie, enabled FROM bet_alert_books`).all()) books[r.bookie] = !!r.enabled;
  const anyOff = Object.values(books).some(v => !v);
  const hasMap = Object.keys(books).length > 0;
  return bk => {
    if (!hasMap || !bk) return true;
    const canon = resolveBook(bk);
    if (canon && (canon in books)) return books[canon];
    if (bk in books) return books[bk];
    return !anyOff;
  };
}

// ---- feeds ----
async function getJson(path) {
  try {
    const r = await fetch(BASE + path, { signal: AbortSignal.timeout(20000) });
    const d = await r.json();
    return d && d.ok ? d : null;
  } catch (e) { return null; }
}
const NORMAL_EV_ROUTES = [
  '/api/oc-ev', '/api/oc-boost-ev', '/api/pricedup-horse-ev', '/api/pricedup-acca-ev', '/api/paddypower-horse-ev',
  '/api/starsports-acca-ev', '/api/dragonbet-acca-ev', '/api/planetsportbet-acca-ev',
  '/api/williamhill-acca-ev', '/api/williamhill-tennis-acca-ev', '/api/darts-boost-ev',
  '/api/bestodds-acca-ev', '/api/bestodds-horse-ev', '/api/bestodds-football-boost-ev',
  '/api/properbet-acca-ev', '/api/properbet-horse-ev', '/api/properbet-football-boost-ev',
  '/api/fairplay-boost-ev', '/api/planetsportbet-horse-ev', '/api/williamhill-horse-ev',
  '/api/pricedup-football-boost-ev', '/api/starsports-football-boost-ev',
  '/api/planetsportbet-football-boost-ev', '/api/dragonbet-football-boost-ev',
  '/api/sportingbet-boost-ev', '/api/betway-boost-ev', '/api/grosvenor-boost-ev',
];
async function betsFrom(paths) {
  const res = await Promise.all(paths.map(getJson));
  return res.flatMap(d => (d && Array.isArray(d.bets)) ? d.bets : []);
}

// index.html mergeHorseDoubleDuplicates — one row per (mkt, sel) / horse legKey, highest EV kept.
function mergeDuplicates(bets) {
  const groups = new Map(), out = [];
  for (const b of bets) {
    const key = ((b.mkt === 'Horse Double' || b.mkt === 'Horse Win') && b.legKey) ? ('leg:' + b.mkt + '|' + b.legKey)
      : (b.sel ? ('sel:' + b.mkt + '|' + b.sel) : null);
    if (!key) { out.push(b); continue; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  groups.forEach(g => out.push(g.slice().sort((x, y) => (y.ev ?? -Infinity) - (x.ev ?? -Infinity))[0]));
  return out;
}

// index.html calcEvMinPct
const CALC_EV_HIGH_EDGE_GOAL_MARKETS = new Set(['OTB', 'Left Foot Goal', 'Right Foot Goal', 'Inside Box Goal']);
const CALC_EV_SOT_MARKETS = new Set(['Headed SOT', 'OTB SOT', 'Left Foot SOT', 'Right Foot SOT', 'Inside Box SOT']);
function calcEvMinPct(market) {
  if (CALC_EV_HIGH_EDGE_GOAL_MARKETS.has(market)) return 75.0;
  if (CALC_EV_SOT_MARKETS.has(market)) return 20.0;
  if (market === 'Header') return 20.0;
  return 5.0;
}
const OTW_THRESHOLD_PCT = 3.0;
const EP_MIN_EV = 10;
const OUTLIERS_ALL_MARKETS = new Set(['AGS', 'First scorer', 'Cards', 'SOT', 'Assist', 'Shots 1+', 'Shots 2+', 'Shots 3+']);

// Each builder returns the tab's shown bets as
//   { match, market, selection, bk, odds, fair, ev, t, extra }  (extra = optional text bit)
// Per-user filtering (placed ticks, removed bets) happens later in perUserFilter.
const BUILDERS = {
  async 'oc-ev'(ctx) {
    let bets = (await betsFrom(NORMAL_EV_ROUTES)).filter(b => !/\b(header|headed|otb)\b/i.test(String(b.mkt || '')));
    bets = mergeDuplicates(bets);
    return bets.filter(b => (!b.source || b.source === 'bfex') && !kickoffPassed(b.d, b.t) && ctx.bookOk(b.bk))
      .map(b => ({ match: b.match, market: b.mkt, selection: b.sel, bk: bookName(b.bk), odds: num(b.odds), fair: num(b.fair), ev: num(b.ev), t: b.t, d: b.d, matchId: b.matchId }));
  },
  async 'calc-ev'(ctx) {
    const out = [];
    for (const b of await betsFrom(['/api/oc-calc-ev', '/api/oc-boost-calc-ev'])) {
      if (b.noCalc || kickoffPassed(b.d, b.t)) continue;
      const fair = num(b.ocBbBlendFair);            // fairs source default 'blend' (applyFairsSource)
      if (fair == null || !(fair > 0)) continue;
      let bk = b.bk, odds = num(b.odds);
      if (!ctx.bookOk(bk)) {                         // remapToAllowedBook
        bk = null; odds = null;
        for (const [code, price] of Object.entries(b.allOdds || {})) {
          if (ctx.bookOk(code) && (odds == null || price > odds)) { odds = price; bk = code; }
        }
        if (bk == null) continue;
      }
      if (!(odds > 0)) continue;
      const ev = (odds / fair - 1) * 100;
      if (ev < calcEvMinPct(b.mkt)) continue;
      out.push({ match: b.match, market: b.mkt, selection: b.sel, bk: bookName(bk), odds, fair, ev, t: b.t, d: b.d, matchId: b.matchId });
    }
    return out;
  },
  async watch(ctx) {
    const rows = db.prepare(
      `SELECT match, match_id AS matchId, kickoff, kickoff_date AS kickoffDate, market, selection, bookie, odds, oc_bb_blend_fair AS blend
         FROM ones_to_watch WHERE state != 'removed'`
    ).all();
    const out = [];
    for (const r of rows) {
      if (!ctx.bookOk(r.bookie) || kickoffPassed(r.kickoffDate, r.kickoff)) continue;
      const fair = num(r.blend), odds = num(r.odds);
      if (fair == null || !(fair > 0) || !(odds > 0)) continue;
      const ev = (odds / fair - 1) * 100;
      if (ev < OTW_THRESHOLD_PCT) continue;
      out.push({ match: r.match, market: r.market, selection: r.selection, bk: bookName(r.bookie), odds, fair, ev, t: r.kickoff, d: r.kickoffDate, matchId: r.matchId });
    }
    return out;
  },
  async early(ctx) {
    const d = await getJson('/api/early-prices');
    const out = [];
    for (const r of (d && Array.isArray(d.bets)) ? d.bets : []) {
      if (kickoffPassed(r.d, r.t)) continue;
      if (!(r.last5 || []).some(v => v >= r.line)) continue;            // "Landed in last 5" (on by default)
      const pick = [{ bk: r.bk, odds: r.odds }].concat(r.alsoAbove || []).find(x => ctx.bookOk(bookName(x.bk) || x.bk));
      if (!pick) continue;
      const fair = num(r.fair), odds = num(pick.odds);
      const ev = fair && odds ? (odds / fair - 1) * 100 : null;
      if (ev == null || ev < EP_MIN_EV) continue;
      out.push({ match: r.match, market: r.mkt, selection: r.sel, bk: bookName(pick.bk), odds, fair, ev, t: r.t, d: r.d, matchId: r.matchId,
        extra: r.lineup === 'confirmed' ? 'lineup confirmed' : 'predicted XI' });
    }
    return out;
  },
  'f1-ew': ctx => stubFeed(ctx, '/api/oc-f1-ew', true),
  arbs: ctx => stubFeed(ctx, '/api/oc-arbs', false),
  dnf: ctx => stubFeed(ctx, '/api/oc-dnf', false),
  'nfl-td': ctx => stubFeed(ctx, '/api/nfl-td-ev', true),
  async errors() {
    const d = await getJson('/api/bet-alert-errors');
    return ((d && d.rows) || []).map(r => ({ match: r.match, market: r.market, selection: r.selection, bk: r.bookie,
      odds: num(r.odds), t: r.firstLegTime, extra: r.reason || 'still open past its first leg', keyExtra: r.source }));
  },
  async unmatched() {
    const d = await getJson('/api/oc-unmatched-matches');
    const ignored = new Set(db.prepare(`SELECT match_key FROM oc_coverage_ignored WHERE ignored_at >= datetime('now', ?)`)
      .all(OC_COVERAGE_IGNORE_WINDOW).map(r => r.match_key));
    return ((d && d.rows) || []).filter(r => !ignored.has(norm(r.match)))
      .map(r => ({ match: r.match, market: 'OC Coverage', selection: r.kickoff || '', t: r.kickoff, extra: 'not found on Oddschecker',
        line: `**OC Coverage:** ${r.match}${r.kickoff ? ' ' + r.kickoff : ''} — not found on Oddschecker, so no AGS/SOT/Header/OTB coverage` }));
  },
  async outliers(ctx) {
    const d = await getJson('/api/oc-outliers');
    return ((d && d.rows) || []).filter(r => r.lineupConfirmed && OUTLIERS_ALL_MARKETS.has(r.market)
        && ctx.bookOk(r.topBook) && !kickoffPassed(r.kickoffDate, r.kickoff))
      .map(r => ({ match: r.match, market: r.market, selection: r.selection, bk: bookName(r.topBook), odds: num(r.topPrice),
        ev: num(r.pctAboveNext), evLabel: 'above next', t: r.kickoff, d: r.kickoffDate, matchId: r.matchId,
        extra: r.nextPrice != null ? `next best ${Number(r.nextPrice).toFixed(2)}${r.nextBook ? ' at ' + bookName(r.nextBook) : ''}` : null,
        removedKey: 'outliers | ' + betKey({ match: r.match, market: r.market, selection: r.selection }) }));
  },
  async grosvenor() {
    const d = await getJson('/api/grosvenor-best');
    return ((d && (d.bets || d.rows)) || []).filter(r => r.lineupConfirmed && !kickoffPassed(r.d, r.t))
      .map(r => ({ match: r.match, market: r.mkt, selection: r.sel, bk: 'Grosvenor', odds: num(r.odds),
        ev: num(r.pct), evLabel: 'above next', t: r.t, d: r.d, matchId: r.matchId,
        extra: r.nextBest != null ? `next best ${Number(r.nextBest).toFixed(2)}${r.nextBook ? ' at ' + bookName(r.nextBook) : ''}` : null,
        removedKey: betKey({ match: r.match, market: r.mkt, selection: r.sel }) }));
  },
};
// index.html renderBaStubFeed — book filter, and F1 EW / NFL TDs collapse to the best book per bet.
async function stubFeed(ctx, path, collapse) {
  const d = await getJson(path);
  let shown = ((d && d.bets) || []).filter(b => ctx.bookOk(b.bk));
  if (collapse) {
    const best = {};
    for (const b of shown) {
      const k = `${b.match}|${b.mkt}|${b.sel}`;
      if (!best[k] || (b.odds ?? 0) > (best[k].odds ?? 0)) best[k] = b;
    }
    shown = Object.values(best);
  }
  return shown.map(b => ({ match: b.match, market: b.mkt, selection: b.sel, bk: bookName(b.bk), odds: num(b.odds),
    fair: num(b.fair), ev: num(b.ev != null ? b.ev : b.profit_pct), evLabel: b.ev == null && b.profit_pct != null ? 'profit' : null, t: b.t }));
}

// ---- message text ----
const fmtOdds = v => v != null ? Number(v).toFixed(2) : null;
function betLine(label, b, prev) {
  if (b.line) return b.line;
  let s = `**${label}:** ${b.selection || b.match}`;
  if (b.market) s += `, ${b.market}`;
  if (b.odds != null) s += ` @ ${fmtOdds(b.odds)}`;
  if (b.bk) s += ` at ${b.bk}`;
  if (b.ev != null) s += ` (${b.ev >= 0 ? '+' : ''}${b.ev.toFixed(1)}%${b.evLabel ? ' ' + b.evLabel : ''})`;
  if (b.fair != null) s += `, fair ${fmtOdds(b.fair)}`;
  if (b.selection && b.match) s += `, ${b.match}`;
  // Horse races already carry the time in the race name ("15:31 Newcastle") — don't repeat it.
  if (b.t && b.t !== b.selection && !String(b.match || '').includes(b.t)) s += ` ${b.t}`;
  if (b.extra) s += ` — ${b.extra}`;
  if (prev) {
    const was = [prev.odds != null && b.odds != null && prev.odds !== b.odds ? `odds ${fmtOdds(prev.odds)}` : null,
                 prev.ev != null && b.ev != null ? `EV ${prev.ev >= 0 ? '+' : ''}${prev.ev.toFixed(1)}%` : null].filter(Boolean);
    s = `↻ ${s}${was.length ? ` _(was ${was.join(', ')})_` : ''}`;
  }
  return s.slice(0, 4000);
}

// ---- sending ----
const WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
function validWebhook(url) { return WEBHOOK_RE.test(String(url || '').trim()); }
function maskWebhook(url) {
  const m = String(url || '').match(/\/webhooks\/(\d+)\/([\w-]+)$/);
  return m ? `…/webhooks/${m[1].slice(0, 4)}…/${m[2].slice(0, 3)}…${m[2].slice(-3)}` : '';
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One POST to the webhook, retrying 429s. Returns { ok, status, error }.
async function postWebhook(url, payload) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(url + '?wait=true', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ username: 'BuzzerBetting Alerts', allowed_mentions: { parse: [] } }, payload)),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) { return { ok: false, status: 0, error: 'network: ' + e.message }; }
    if (res.ok) return { ok: true, status: res.status };
    if (res.status === 429) {
      let wait = 2;
      try { const j = await res.json(); if (j && j.retry_after != null) wait = Number(j.retry_after); } catch (e) {
        const h = Number(res.headers.get('retry-after')); if (isFinite(h) && h > 0) wait = h;
      }
      await sleep(Math.min(Math.max(wait, 0.5), 60) * 1000 + 250);
      continue;
    }
    let body = '';
    try { body = (await res.text()).slice(0, 200); } catch (e) {}
    return { ok: false, status: res.status, error: `HTTP ${res.status}${body ? ': ' + body : ''}` };
  }
  return { ok: false, status: 429, error: 'rate limited (429) after 3 tries' };
}
const isDeadStatus = s => s === 401 || s === 403 || s === 404;

function markDead(username, slot, error) {
  db.prepare(`UPDATE discord_hooks SET status = 'dead', last_error = ?, updated_at = ? WHERE username = ? AND slot = ?`)
    .run(error, new Date().toISOString(), username, slot);
  QUEUES.delete(qKey(username, slot));
  console.warn(`[discord] webhook ${slot} for ${username} marked dead: ${error}`);
}

// One queue per webhook (user + slot) -> { username, slot, embeds: [], sentTimes: [ms], busy }
const QUEUES = new Map();
const qKey = (username, slot) => `${username}\u0000${slot}`;
function queueFor(username, slot) {
  const k = qKey(username, slot);
  if (!QUEUES.has(k)) QUEUES.set(k, { username, slot, embeds: [], sentTimes: [], busy: false });
  return QUEUES.get(k);
}
async function flush(q) {
  if (q.busy || !q.embeds.length) return;
  const { username, slot } = q;
  q.busy = true;
  try {
    while (q.embeds.length) {
      const now = Date.now();
      q.sentTimes = q.sentTimes.filter(t => now - t < 60000);
      if (q.sentTimes.length >= MAX_MSGS_PER_MIN) break;      // rest waits for the next tick
      const hook = db.prepare(`SELECT url, status FROM discord_hooks WHERE username = ? AND slot = ?`).get(username, slot);
      if (!hook || hook.status !== 'ok') { q.embeds = []; break; }
      const batch = q.embeds.slice(0, EMBEDS_PER_MSG);
      const r = await postWebhook(hook.url, { embeds: batch });
      q.sentTimes.push(Date.now());
      if (r.ok) {
        q.embeds.splice(0, batch.length);
        db.prepare(`UPDATE discord_hooks SET last_sent_at = ?, last_error = NULL WHERE username = ? AND slot = ?`).run(new Date().toISOString(), username, slot);
      } else if (isDeadStatus(r.status)) {
        markDead(username, slot, r.error); break;
      } else {
        db.prepare(`UPDATE discord_hooks SET last_error = ? WHERE username = ? AND slot = ?`).run(r.error, username, slot);
        break;                                              // transient — try again next tick
      }
      await sleep(1200);
    }
  } finally { q.busy = false; }
}

async function sendTest(url, username, slot) {
  const who = username ? ` for ${username}${slot ? ` (webhook ${slot})` : ''}` : '';
  return postWebhook(url, { embeds: [{
    description: `✅ **BuzzerBetting test message** — Discord alerts are connected${who}. New bets on the tabs you switch on for this webhook will post here.`,
    color: 0x16a34a, timestamp: new Date().toISOString(),
  }] });
}

// ---- "Confirmed lineups only" (per webhook, 2026-10-30) ----
// When it's on, a bet only posts if it belongs to one football match (FotMob matchId on the row)
// whose lineups FotMob says are confirmed — same check as the header bell's Lineups Confirmed
// (netlify/functions/lineups.js). Tabs with no lineups (horses, darts, F1, NFL, arbs, Errors,
// OC Coverage) and rows without a single match (accas, bookie boost pages) are left out.
// Only matches kicking off within LINEUP_LOOKAHEAD_MS are asked about (lineups land ~1h before);
// a confirmed match stays confirmed, an unconfirmed one is re-asked at most every 2 minutes.
const LINEUP_EDGES = new Set(['oc-ev', 'calc-ev', 'watch', 'early', 'outliers', 'grosvenor']);
const LINEUP_LOOKAHEAD_MS = 3 * 3600 * 1000;
const LINEUP_RECHECK_MS = 2 * 60 * 1000;
const lineupState = new Map(); // matchId -> { confirmed, checkedAt }
let lineupsHandler = null;
async function confirmedMatchIds(rows) {
  if (!lineupsHandler) lineupsHandler = require('./netlify/functions/lineups').handler;
  const now = Date.now();
  const ids = new Set();
  for (const b of rows) {
    if (!b || b.matchId == null || b.matchId === '') continue;
    const ko = kickoffTs(b.d, b.t);
    if (ko == null || ko - now > LINEUP_LOOKAHEAD_MS) continue;
    ids.add(String(b.matchId));
  }
  const toCheck = [...ids].filter(id => {
    const s = lineupState.get(id);
    return !s || (!s.confirmed && now - s.checkedAt >= LINEUP_RECHECK_MS);
  });
  for (let i = 0; i < toCheck.length; i += 4) {
    await Promise.all(toCheck.slice(i, i + 4).map(async id => {
      let confirmed = false;
      try {
        const r = await lineupsHandler({ httpMethod: 'GET', queryStringParameters: { matchId: id } });
        const lu = JSON.parse(r.body);
        confirmed = !!(lu && lu.ok && lu.confirmed);
      } catch (e) {}
      lineupState.set(id, { confirmed, checkedAt: Date.now() });
    }));
  }
  for (const [id, s] of lineupState) if (now - s.checkedAt > 24 * 3600 * 1000) lineupState.delete(id);
  return new Set([...ids].filter(id => lineupState.get(id) && lineupState.get(id).confirmed));
}

// ---- main tick ----
function prefsFor(username, slot) {
  const row = db.prepare(`SELECT prefs FROM discord_hook_tabs WHERE username = ? AND slot = ?`).get(username, slot);
  try { return (row && JSON.parse(row.prefs)) || {}; } catch (e) { return {}; }
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    // One entry per working webhook — a user with two webhooks is handled as two separate posters.
    const hooks = db.prepare(`SELECT username, slot, confirmed_only FROM discord_hooks WHERE status = 'ok'`).all()
      .map(h => ({ username: h.username, slot: h.slot, prefs: prefsFor(h.username, h.slot), confirmedOnly: !!h.confirmed_only }))
      .filter(h => Object.keys(DISCORD_EDGES).some(e => h.prefs[e] === true));
    const today = londonDay();
    if (hooks.length) {
      const wanted = new Set(hooks.flatMap(h => Object.keys(DISCORD_EDGES).filter(e => h.prefs[e] === true)));
      const ctx = { bookOk: makeBookFilter() };
      const feeds = {};
      await Promise.all([...wanted].map(async e => {
        try { feeds[e] = await BUILDERS[e](ctx); } catch (err) { console.error(`[discord] ${e} build failed:`, err.message); feeds[e] = null; }
      }));
      let confirmedIds = new Set();
      if (hooks.some(h => h.confirmedOnly)) {
        try {
          confirmedIds = await confirmedMatchIds([...LINEUP_EDGES].flatMap(e => Array.isArray(feeds[e]) ? feeds[e] : []));
        } catch (err) { console.error('[discord] lineup check failed:', err.message); }
      }

      const getSent = db.prepare(`SELECT odds, ev FROM discord_hook_sent WHERE username = ? AND slot = ? AND edge = ? AND bet_key = ?`);
      const putSent = db.prepare(
        `INSERT INTO discord_hook_sent (username, slot, edge, bet_key, odds, ev, seen_day) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(username, slot, edge, bet_key) DO UPDATE SET odds = excluded.odds, ev = excluded.ev, sent_at = datetime('now'), seen_day = excluded.seen_day`);
      const touchSent = db.prepare(`UPDATE discord_hook_sent SET seen_day = ? WHERE username = ? AND slot = ? AND edge = ? AND bet_key = ?`);
      const isSeeded = db.prepare(`SELECT 1 FROM discord_hook_seeded WHERE username = ? AND slot = ? AND edge = ?`);
      const markSeeded = db.prepare(`INSERT OR IGNORE INTO discord_hook_seeded (username, slot, edge) VALUES (?, ?, ?)`);

      const ticks = new Map(); // username -> { placed, removed } — shared by both of a user's webhooks
      for (const h of hooks) {
        if (!ticks.has(h.username)) ticks.set(h.username, {
          placed: new Set(db.prepare(`SELECT bet_key FROM bet_alert_placed WHERE username = ? AND placed_at >= datetime('now', ?)`)
            .all(h.username, PLACED_LOOKBACK).map(r => r.bet_key)),
          removed: new Set(db.prepare(`SELECT bet_key FROM bet_alert_removed WHERE username = ? AND removed_at >= datetime('now', ?)`)
            .all(h.username, PLACED_LOOKBACK).map(r => r.bet_key)),
        });
        const { placed, removed } = ticks.get(h.username);
        const embeds = [];
        db.transaction(() => {
          for (const edge of Object.keys(DISCORD_EDGES)) {
            if (h.prefs[edge] !== true || !Array.isArray(feeds[edge])) continue;   // null = feed failed this tick, skip
            if (h.confirmedOnly && !LINEUP_EDGES.has(edge)) continue;
            const seeding = !isSeeded.get(h.username, h.slot, edge);
            for (const b of feeds[edge]) {
              if (!b || (!b.match && !b.selection)) continue;
              // Not recorded as sent either, so it still posts as new the moment its lineup lands.
              if (h.confirmedOnly && !(b.matchId != null && confirmedIds.has(String(b.matchId)))) continue;
              const bk = betKey(b);
              if (placed.has(bk) || (b.removedKey && removed.has(b.removedKey))) continue;
              const key = `${bk} | ${norm(b.bk)}${b.keyExtra ? ' | ' + norm(b.keyExtra) : ''}`;
              const prev = getSent.get(h.username, h.slot, edge, key);
              let post = false, wasPrev = null;
              if (!prev) post = true;
              else {
                const oddsMoved = prev.odds != null && b.odds != null && Math.abs(b.odds / prev.odds - 1) >= ODDS_MOVE;
                const evMoved = prev.ev != null && b.ev != null && Math.abs(b.ev - prev.ev) >= EV_MOVE_PTS;
                if (oddsMoved || evMoved) { post = true; wasPrev = prev; }
              }
              if (post) {
                putSent.run(h.username, h.slot, edge, key, b.odds, b.ev, today);
                if (!seeding) embeds.push({ description: betLine(DISCORD_EDGES[edge], b, wasPrev), color: EDGE_COLOR[edge] });
              } else {
                touchSent.run(today, h.username, h.slot, edge, key);
              }
            }
            if (seeding) markSeeded.run(h.username, h.slot, edge);
          }
        })();
        if (embeds.length) {
          const q = queueFor(h.username, h.slot);
          q.embeds.push(...embeds);
          if (q.embeds.length > MAX_QUEUE) q.embeds.splice(0, q.embeds.length - MAX_QUEUE);
          console.log(`[discord] ${h.username} (webhook ${h.slot}): queued ${embeds.length} new bet${embeds.length === 1 ? '' : 's'}`);
        }
      }
    }
    // Daily clear: forget anything that hasn't been on its feed since before London midnight.
    db.prepare(`DELETE FROM discord_hook_sent WHERE seen_day < ?`).run(today);
    for (const q of QUEUES.values()) flush(q).catch(err => console.error('[discord] flush failed:', err.message));
  } catch (err) {
    console.error('[discord] tick failed:', err && err.message);
  } finally { running = false; }
}

function startDiscordAlerts() {
  setTimeout(() => { tick(); setInterval(tick, TICK_MS); }, FIRST_RUN_DELAY_MS);
  console.log('[discord] bet alerts notifier scheduled (every 60s)');
}

module.exports = { startDiscordAlerts, sendTest, validWebhook, maskWebhook, isDeadStatus, DISCORD_EDGES, _tick: tick, _betLine: betLine };

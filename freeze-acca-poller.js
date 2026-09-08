// Freeze-acca result poller.
//
// Every ~15 min: for every OPEN `Freeze` bet in the new "freeze-acca" format (has fields.legs),
// resolve each leg that has kicked off and isn't resolved yet:
//   1. FotMob — fotmob.com/api/data/matches?date= for the leg's date, fuzzy-match both teams,
//      read the finished score, decide won/lost for the backed side.
//   2. Betfair fallback — the leg's stored bfexMarketId + bfexSelectionId → the settled
//      MATCH_ODDS runner status (WINNER/LOSER).
// Results are written to fields.legResults (index-aligned to fields.legs) so the Freeze
// tracker can colour the legs. If ANY fodder leg loses, the acca is auto-settled LOST via the
// server's own PATCH /bets/:id/settle (a freeze-leg loss does not — the token may have covered it).

const db = require('./ledger-db');

const TICK_MS = 15 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;
const SETTLE_LAG_MS = 90 * 60 * 1000; // don't even ask FotMob until ~90 min after KO
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

// ── team-name matching (same idea as bb-lead.js / skybet-bfex-lib.js) ──
function norm(n) {
  return (n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\butd\b/g, 'united').replace(/\bnottm\b/g, 'nottingham').replace(/\bwolves\b/g, 'wolverhampton')
    .replace(/\bspurs\b/g, 'tottenham').replace(/\bmunich\b/g, 'munchen')
    .replace(/\b(fc|afc|cf|sc|ss|as|ac|sv|bk|if|fk|club|w|res)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function teamEq(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = na.split(' ').filter(w => w.length > 2), wb = nb.split(' ').filter(w => w.length > 2);
  if (!wa.length || !wb.length) return false;
  const [s, l] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (s.length === 1) return s[0] === l[0];
  return s.every(w => l.join(' ').includes(w)) || l.every(w => s.join(' ').includes(w));
}

function londonYmd(iso) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(iso)).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${p.year}${p.month}${p.day}`;
}

// every finished match FotMob knows about for a London date
async function fotmobFinished(yyyymmdd) {
  const url = `https://www.fotmob.com/api/data/matches?date=${yyyymmdd}&timezone=Europe%2FLondon&ccode3=GBR&includeNextDayLateNight=true`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://www.fotmob.com/' } });
  if (!r.ok) throw new Error('FotMob HTTP ' + r.status);
  const raw = await r.json();
  const out = [];
  for (const lg of (raw.leagues || []))
    for (const m of (lg.matches || [])) {
      if (!(m.status && m.status.finished) || !m.status.scoreStr) continue;
      out.push({ home: m.home && m.home.name, away: m.away && m.away.name, score: m.status.scoreStr });
    }
  return out;
}
// 'won' | 'lost' | null  (null = not found / not finished / unparseable)
function fotmobLegResult(leg, matches) {
  const m = matches.find(x =>
    (teamEq(leg.team, x.home) && teamEq(leg.opp, x.away)) ||
    (teamEq(leg.team, x.away) && teamEq(leg.opp, x.home)));
  if (!m) return null;
  const mm = String(m.score).match(/(\d+)\s*[-–]\s*(\d+)/);
  if (!mm) return null;
  const hg = +mm[1], ag = +mm[2];
  const backedIsHome = teamEq(leg.team, m.home);
  const mine = backedIsHome ? hg : ag, theirs = backedIsHome ? ag : hg;
  return mine > theirs ? 'won' : 'lost'; // a draw is a loss for a straight win bet
}

// ── Betfair fallback (settled MATCH_ODDS runner status) ──
async function betfairStatuses(marketIds) {
  let bf;
  try { bf = require('./skybet-bfex-lib')._bf; } catch (e) { return {}; }
  if (!bf || !bf.hasCert()) return {};
  const appKey = process.env.BFEX_APP_KEY;
  if (!appKey) return {};
  const session = await bf.getSessionToken();
  const out = {}; // marketId -> { selectionId: status }
  for (let i = 0; i < marketIds.length; i += 40) {
    const chunk = marketIds.slice(i, i + 40);
    const books = await bf.bfCall('listMarketBook', { marketIds: chunk }, appKey, session);
    for (const b of (books || [])) {
      out[b.marketId] = {};
      for (const r of (b.runners || [])) out[b.marketId][r.selectionId] = r.status;
    }
  }
  return out;
}

async function autoSettleLost(bet) {
  const key = process.env.LEDGER_API_KEY;
  const port = process.env.PORT || 3000;
  const stake = bet.total_stake || 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ledger/bets/${bet.id}/settle`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-ledger-key': key },
      body: JSON.stringify({ result: 'lost', pl: -Math.abs(stake) }),
    });
    const j = await r.json().catch(() => ({}));
    console.log(`[freeze-poll] auto-settled bet ${bet.id} LOST (stake ${stake}) -> ${j.ok ? 'ok' : (j.error || 'failed')}`);
  } catch (e) {
    console.error('[freeze-poll] auto-settle failed for', bet.id, e && e.message);
  }
}

async function tick() {
  try {
    const bets = db.prepare("SELECT * FROM bets WHERE bet_type = 'Freeze' AND result = 'open'").all()
      .map(b => ({ ...b, f: safeParse(b.fields) }))
      .filter(b => b.f && b.f.format === 'freeze-acca' && Array.isArray(b.f.legs) && b.f.legs.length);
    if (!bets.length) return;

    const now = Date.now();
    const pending = []; // { bet, i, leg }
    for (const b of bets) {
      b._results = Array.isArray(b.f.legResults) && b.f.legResults.length === b.f.legs.length
        ? b.f.legResults.slice()
        : new Array(b.f.legs.length).fill(null);
      b.f.legs.forEach((leg, i) => {
        if (b._results[i]) return;
        const kt = leg.kickoff ? Date.parse(leg.kickoff) : NaN;
        if (Number.isNaN(kt) || now - kt < SETTLE_LAG_MS) return;
        pending.push({ b, i, leg });
      });
    }
    if (!pending.length) return;

    // FotMob, one fetch per distinct London date
    const dateCache = {};
    for (const { leg } of pending) {
      const d = londonYmd(leg.kickoff);
      if (!(d in dateCache)) {
        try { dateCache[d] = await fotmobFinished(d); }
        catch (e) { dateCache[d] = []; console.error('[freeze-poll] FotMob', d, e && e.message); }
      }
    }
    for (const p of pending) {
      const r = fotmobLegResult(p.leg, dateCache[londonYmd(p.leg.kickoff)] || []);
      if (r) p.b._results[p.i] = r;
    }

    // Betfair fallback for legs FotMob couldn't resolve
    const fallback = pending.filter(p => !p.b._results[p.i] && p.leg.bfexMarketId && p.leg.bfexSelectionId != null);
    if (fallback.length) {
      try {
        const statuses = await betfairStatuses([...new Set(fallback.map(p => p.leg.bfexMarketId))]);
        for (const p of fallback) {
          const st = statuses[p.leg.bfexMarketId] && statuses[p.leg.bfexMarketId][p.leg.bfexSelectionId];
          if (st === 'WINNER') p.b._results[p.i] = 'won';
          else if (st === 'LOSER') p.b._results[p.i] = 'lost';
        }
      } catch (e) { console.error('[freeze-poll] betfair fallback:', e && e.message); }
    }

    // persist changed results + auto-settle any acca with a lost fodder leg
    for (const b of bets) {
      const changed = JSON.stringify(b._results) !== JSON.stringify(b.f.legResults || null);
      if (changed) {
        b.f.legResults = b._results;
        b.f.legResultsCheckedAt = new Date().toISOString();
        db.prepare('UPDATE bets SET fields = ? WHERE id = ?').run(JSON.stringify(b.f), b.id);
      }
      const lostFodder = b.f.legs.some((leg, i) => !leg.isFreeze && b._results[i] === 'lost');
      if (lostFodder) await autoSettleLost(b);
    }
  } catch (err) {
    console.error('[freeze-poll] tick failed:', err && err.message);
  }
}

function start() {
  setTimeout(tick, FIRST_RUN_DELAY_MS);
  setInterval(tick, TICK_MS);
  console.log('[freeze-poll] freeze-acca poller started');
}

module.exports = { start, _tick: tick };

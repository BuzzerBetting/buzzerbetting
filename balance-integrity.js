// Account balance integrity check (2026-10-08, user-requested) — runs inside the ledger server
// every couple of minutes and writes an "Account Balance Error Log" row whenever an account's
// live balance stops agreeing with what its own history says it should be, or a settled bet's
// P/L doesn't fit its stake and odds. Each row can be given a reason once it's been looked at.
//
// Expected balance, rebuilt from scratch on every run:
//   starting balance + deposits − withdrawals (not reversed) − locked funds + manual overrides
//   − external stakes + every bet leg (settled: its P/L; open: minus the stake still out —
//   nothing for free bets/casino, the liability for a lay leg).
// Accounts already off when the check first ran get one "already off" row each; after that a
// row is only written when the gap CHANGES — so each row is one new discrepancy, and a reason
// given once doesn't keep coming back.
const db = require('./ledger-db');

const TOL = 0.015;

db.exec(`
CREATE TABLE IF NOT EXISTS balance_check_state (
  account_id INTEGER PRIMARY KEY,
  drift      REAL NOT NULL,      -- live − expected at the last check
  expected   REAL,
  live       REAL,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS balance_check_meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS bet_pl_checks (
  bet_id INTEGER PRIMARY KEY,
  pl     REAL,                   -- the P/L that was checked (re-checked if it changes)
  ok     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS balance_errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,     -- 'balance' (live ≠ expected) | 'bet_pl' (P/L doesn't fit stake × odds)
                                 -- | 'override' (live balance overridden: expected = old, live = new)
  account_id  INTEGER,
  bet_id      INTEGER,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  expected    REAL,              -- balance: expected balance | bet_pl: nearest valid P/L
  live        REAL,              -- balance: live balance     | bet_pl: recorded P/L
  change      REAL,              -- balance: how much the gap moved by in this row | bet_pl: recorded − nearest
  drift       REAL,              -- balance: total gap after this row
  initial     INTEGER NOT NULL DEFAULT 0,  -- 1 = already off when the check first ran
  detail      TEXT,              -- JSON context (bets/deposits around it)
  reason      TEXT,
  reason_by   TEXT,
  reason_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_balance_errors_open ON balance_errors (reason, detected_at);
`);

const meta = k => (db.prepare(`SELECT v FROM balance_check_meta WHERE k = ?`).get(k) || {}).v;
const setMeta = (k, v) => db.prepare(`INSERT INTO balance_check_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(k, v);

function isFreeOrCasino(betType, fields) {
  return betType === 'Casino' || betType === 'Casino (Personal)' || (fields && fields['Bet Type'] === 'Free Bet');
}
function legCommitted(l, freeBet) {
  if (l.role === 'lay') return l.stake * (l.odds - 1);
  if (l.role === 'back') return l.free_bet ? 0 : l.stake;
  return freeBet ? 0 : l.stake;
}
const parse = s => { try { return JSON.parse(s); } catch (e) { return {}; } };
const sumBy = sql => { const m = new Map(); for (const r of db.prepare(sql).all()) m.set(r.id, r.s || 0); return m; };

// Expected balance for every account, in one pass.
function expectedBalances() {
  const dep = sumBy(`SELECT account_id id, SUM(amount) s FROM deposits GROUP BY account_id`);
  const wd = sumBy(`SELECT account_id id, SUM(amount) s FROM withdrawals WHERE status <> 'reversed' GROUP BY account_id`);
  const locked = sumBy(`SELECT linked_account_id id, SUM(amount) s FROM locked_funds WHERE linked_account_id IS NOT NULL GROUP BY linked_account_id`);
  const adj = sumBy(`SELECT account_id id, SUM(delta) s FROM manual_adjustments GROUP BY account_id`);
  let ext = new Map();
  try { ext = sumBy(`SELECT account_id id, SUM(stake) s FROM external_stakes GROUP BY account_id`); } catch (e) { /* table absent */ }
  const bets = new Map();
  const freeCache = new Map();
  for (const l of db.prepare(`SELECT bl.account_id, bl.bet_id, bl.stake, bl.leg_pl, bl.settled, bl.role, bl.odds, bl.free_bet, b.bet_type, b.fields
                              FROM bet_legs bl JOIN bets b ON b.id = bl.bet_id`).all()) {
    let free = freeCache.get(l.bet_id);
    if (free === undefined) { free = isFreeOrCasino(l.bet_type, parse(l.fields)); freeCache.set(l.bet_id, free); }
    const v = l.settled ? (l.leg_pl || 0) : -legCommitted(l, free);
    bets.set(l.account_id, (bets.get(l.account_id) || 0) + v);
  }
  const out = [];
  for (const a of db.prepare(`SELECT id, account_id, bookie, status, balance, starting_balance FROM accounts`).all()) {
    const g = m => m.get(a.id) || 0;
    const expected = (a.starting_balance || 0) + g(dep) - g(wd) - g(locked) + g(adj) - g(ext) + g(bets);
    out.push({ ...a, expected: +expected.toFixed(2), live: +(a.balance || 0).toFixed(2), drift: +((a.balance || 0) - expected).toFixed(2) });
  }
  return out;
}

// What touched this account since `since` — shown on the error row to help put a reason to it.
function activitySince(accountId, since) {
  const items = [];
  const s = since || '1970-01-01';
  db.prepare(`SELECT id, amount, date FROM deposits WHERE account_id = ? AND datetime(created_at) >= datetime(?)`).all(accountId, s)
    .forEach(d => items.push({ at: d.date, what: `Deposit £${d.amount}` }));
  db.prepare(`SELECT id, amount, status, date FROM withdrawals WHERE account_id = ? AND (datetime(created_at) >= datetime(?) OR datetime(reversed_at) >= datetime(?))`).all(accountId, s, s)
    .forEach(w => items.push({ at: w.date, what: `Withdrawal £${w.amount} (${w.status})` }));
  db.prepare(`SELECT old_balance, new_balance, created_by, date FROM manual_adjustments WHERE account_id = ? AND datetime(date) >= datetime(?)`).all(accountId, s)
    .forEach(m => items.push({ at: m.date, what: `Override £${m.old_balance} → £${m.new_balance} by ${m.created_by || '?'}` }));
  db.prepare(`SELECT b.id, b.bet_type, b.result, b.pl, b.date, b.settled_at, b.fields, bl.stake, bl.leg_pl FROM bet_legs bl JOIN bets b ON b.id = bl.bet_id
              WHERE bl.account_id = ? AND (datetime(b.created_at) >= datetime(?) OR datetime(b.settled_at) >= datetime(?))`).all(accountId, s, s)
    .forEach(b => {
      const f = parse(b.fields);
      const odds = f.Odds ?? f['Back Odds'];
      items.push({ at: b.settled_at || b.date, betId: b.id, what: `${b.bet_type} #${b.id} · £${b.stake}${odds ? ' @ ' + odds : ''} · ${b.result}${b.result !== 'open' ? ` (P/L ${b.leg_pl})` : ''}` });
    });
  return items.sort((x, y) => String(x.at).localeCompare(String(y.at))).slice(-25);
}

function checkBalances() {
  const firstRun = !meta('balance_started_at');
  const rows = expectedBalances();
  const state = new Map(db.prepare(`SELECT * FROM balance_check_state`).all().map(r => [r.account_id, r]));
  const ins = db.prepare(`INSERT INTO balance_errors (kind, account_id, expected, live, change, drift, initial, detail) VALUES ('balance', ?, ?, ?, ?, ?, ?, ?)`);
  const up = db.prepare(`INSERT INTO balance_check_state (account_id, drift, expected, live, checked_at) VALUES (?, ?, ?, ?, datetime('now'))
                         ON CONFLICT(account_id) DO UPDATE SET drift = excluded.drift, expected = excluded.expected, live = excluded.live, checked_at = excluded.checked_at`);
  let created = 0;
  db.transaction(() => {
    for (const a of rows) {
      const prev = state.get(a.id);
      if (!prev) {
        // Already off when first seen. A brand-new account (created after the check started)
        // that's off from the start is a real error too, so it's logged the same way.
        if (Math.abs(a.drift) >= TOL) {
          ins.run(a.id, a.expected, a.live, a.drift, a.drift, firstRun ? 1 : 0, JSON.stringify({ activity: firstRun ? [] : activitySince(a.id, null) }));
          created++;
        }
      } else if (Math.abs(a.drift - prev.drift) >= TOL) {
        ins.run(a.id, a.expected, a.live, +(a.drift - prev.drift).toFixed(2), a.drift, 0,
          JSON.stringify({ previousDrift: prev.drift, since: prev.checked_at, activity: activitySince(a.id, prev.checked_at) }));
        created++;
      }
      up.run(a.id, a.drift, a.expected, a.live);
    }
    if (firstRun) setMeta('balance_started_at', new Date().toISOString().slice(0, 19).replace('T', ' '));
  })();
  return created;
}

// ---- settled bet P/L vs stake and odds ----
const EW_FRACTIONS = [1 / 4, 1 / 5, 1 / 3, 1 / 6, 1 / 8];
const COMMISSIONS = [0, 0.02, 0.03, 0.05];
// Every P/L this bet could legitimately have: win (any exchange commission), each-way win or
// place at the usual terms (stake as the total or per way), loss, void. A free bet's loss is £0.
function validPls(stake, odds, free) {
  const c = [0, free ? 0 : -stake, -2 * stake];
  for (const k of COMMISSIONS) c.push(stake * (odds - 1) * (1 - k));
  for (const total of [stake, 2 * stake]) {
    const h = total / 2;
    for (const f of EW_FRACTIONS) {
      const place = h * (1 + (odds - 1) * f);
      c.push(place - total, h * odds + place - total);
      if (free) c.push(h * (odds - 1) + h * (odds - 1) * f, h * (odds - 1) * f);
    }
  }
  return c;
}
function checkBetPls() {
  let since = meta('pl_started_at');
  if (!since) { since = new Date().toISOString().slice(0, 19).replace('T', ' '); setMeta('pl_started_at', since); }
  const bets = db.prepare(`SELECT b.id, b.bet_type, b.fields, b.total_stake, b.result, b.pl, c.pl AS checked_pl
                           FROM bets b LEFT JOIN bet_pl_checks c ON c.bet_id = b.id
                           WHERE b.result IN ('won', 'lost', 'void') AND datetime(b.settled_at) >= datetime(?)
                             AND (c.bet_id IS NULL OR abs(c.pl - b.pl) > 0.005)`).all(since);
  const mark = db.prepare(`INSERT INTO bet_pl_checks (bet_id, pl, ok) VALUES (?, ?, ?) ON CONFLICT(bet_id) DO UPDATE SET pl = excluded.pl, ok = excluded.ok`);
  const ins = db.prepare(`INSERT INTO balance_errors (kind, account_id, bet_id, expected, live, change, detail) VALUES ('bet_pl', ?, ?, ?, ?, ?, ?)`);
  let created = 0;
  db.transaction(() => {
    for (const b of bets) {
      const f = parse(b.fields);
      const odds = typeof f.Odds === 'number' ? f.Odds : (typeof f['Back Odds'] === 'number' ? f['Back Odds'] : null);
      // Casino, Back & Lay (each leg has its own odds) and Winnings-entry sheets have no single
      // stake × odds answer to check against.
      const checkable = odds > 1 && b.total_stake > 0 && !/casino/i.test(b.bet_type) && b.bet_type !== 'Back & Lay' && f.Winnings === undefined;
      if (!checkable) { mark.run(b.id, b.pl, 1); continue; }
      const stake = b.total_stake;
      const cands = validPls(stake, odds, f['Bet Type'] === 'Free Bet');
      const nearest = cands.reduce((best, c) => Math.abs(c - b.pl) < Math.abs(best - b.pl) ? c : best, cands[0]);
      const ok = Math.abs(nearest - b.pl) <= Math.max(0.06, stake * 0.005);
      mark.run(b.id, b.pl, ok ? 1 : 0);
      if (ok) continue;
      const leg = db.prepare(`SELECT account_id FROM bet_legs WHERE bet_id = ? ORDER BY stake DESC LIMIT 1`).get(b.id);
      const sel = f.Bet || f.Selection || f.Horse || f['Horse/Trap'] || f['Bet Description'] || '';
      ins.run(leg ? leg.account_id : null, b.id, +nearest.toFixed(2), +b.pl.toFixed(2), +(b.pl - nearest).toFixed(2),
        JSON.stringify({ betType: b.bet_type, result: b.result, stake, odds, selection: String(sel).slice(0, 80), outcome: f.Outcome || f.Result || null,
          winPl: +(stake * (odds - 1)).toFixed(2) }));
      created++;
    }
  })();
  return created;
}

// ---- balance overrides ----
// An override is someone finding the live balance didn't match the bookie and typing in the
// real figure — so each new one is logged as an error row too (overrides made before the check
// started are only in the override log).
function checkOverrides() {
  let last = meta('adj_last_id');
  if (last == null) {
    last = String((db.prepare(`SELECT MAX(id) m FROM manual_adjustments`).get() || {}).m || 0);
    setMeta('adj_last_id', last);
    return 0;
  }
  const rows = db.prepare(`SELECT * FROM manual_adjustments WHERE id > ? ORDER BY id`).all(Number(last));
  if (!rows.length) return 0;
  const ins = db.prepare(`INSERT INTO balance_errors (kind, account_id, detected_at, expected, live, change, detail) VALUES ('override', ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const m of rows) {
      const prev = db.prepare(`SELECT MAX(date) d FROM manual_adjustments WHERE account_id = ? AND id < ?`).get(m.account_id, m.id).d;
      ins.run(m.account_id, m.date, +m.old_balance.toFixed(2), +m.new_balance.toFixed(2), +m.delta.toFixed(2),
        JSON.stringify({ by: m.created_by, adjustmentId: m.id, activity: activitySince(m.account_id, prev || db.prepare(`SELECT datetime(?, '-3 days') d`).get(m.date).d) }));
    }
    setMeta('adj_last_id', String(rows[rows.length - 1].id));
  })();
  return rows.length;
}

let lastRun = null, running = false;
function runCheck() {
  if (running) return null;
  running = true;
  try {
    const balance = checkBalances();
    const betPl = checkBetPls();
    const overrides = checkOverrides();
    lastRun = new Date().toISOString();
    const total = balance + betPl + overrides;
    if (total) {
      // Jordan-only bell notification (audience 'user:Jordan').
      try {
        db.prepare(`INSERT INTO notifications (type, audience, title, body) VALUES ('balance_error', 'user:Jordan', ?, ?)`)
          .run(`${total} new account balance error${total === 1 ? '' : 's'}`, [
            balance && `${balance} balance mismatch${balance === 1 ? '' : 'es'}`,
            betPl && `${betPl} bet P/L that doesn't fit its odds`,
            overrides && `${overrides} balance override${overrides === 1 ? '' : 's'}`,
          ].filter(Boolean).join(' · '));
      } catch (e) { /* notifications are best-effort */ }
    }
    return { balance, betPl, overrides, lastRun };
  } finally { running = false; }
}

function listErrors(status = 'open', limit = 500) {
  const where = status === 'explained' ? `WHERE e.reason IS NOT NULL` : status === 'all' ? '' : `WHERE e.reason IS NULL`;
  return db.prepare(`
    SELECT e.*, a.account_id AS account_code, a.bookie, a.status AS account_status, a.profile AS bank, a.balance AS current_live,
           s.drift AS current_drift
    FROM balance_errors e
    LEFT JOIN accounts a ON a.id = e.account_id
    LEFT JOIN balance_check_state s ON s.account_id = e.account_id
    ${where}
    ORDER BY e.detected_at DESC, e.id DESC LIMIT ?`).all(Math.min(Number(limit) || 500, 2000))
    .map(r => ({ ...r, detail: parse(r.detail) }));
}
function summary() {
  const c = db.prepare(`SELECT COALESCE(SUM(reason IS NULL), 0) open, COALESCE(SUM(reason IS NOT NULL), 0) explained,
                               COALESCE(SUM(reason IS NULL AND kind = 'balance'), 0) openBalance, COALESCE(SUM(reason IS NULL AND kind = 'bet_pl'), 0) openBetPl,
                               COALESCE(SUM(reason IS NULL AND kind = 'override'), 0) openOverride
                        FROM balance_errors`).get();
  const drift = db.prepare(`SELECT COUNT(*) n, ROUND(SUM(ABS(s.drift)), 2) abs FROM balance_check_state s JOIN accounts a ON a.id = s.account_id
                            WHERE ABS(s.drift) >= ? AND a.status IN ('good', 'restricted')`).get(TOL);
  return { ...c, accountsOff: drift.n, accountsOffAbs: drift.abs || 0, lastRun, startedAt: meta('balance_started_at'), plFrom: meta('pl_started_at') };
}
function setReason(id, reason, username) {
  const r = reason == null || String(reason).trim() === '' ? null : String(reason).trim().slice(0, 500);
  return db.prepare(`UPDATE balance_errors SET reason = ?, reason_by = ?, reason_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END WHERE id = ?`)
    .run(r, r ? (username || null) : null, r, id).changes;
}

function start(intervalMs = 120000) {
  setTimeout(() => { try { runCheck(); } catch (e) { console.error('[balance-integrity]', e.message); } }, 20000);
  setInterval(() => { try { runCheck(); } catch (e) { console.error('[balance-integrity]', e.message); } }, intervalMs);
}

module.exports = { start, runCheck, expectedBalances, listErrors, summary, setReason, validPls };

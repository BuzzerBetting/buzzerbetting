// ledger-routes.js
// Express router for the Ledger system. Mount in your main server file:
//
//   const ledgerRouter = require('./ledger-routes');
//   app.use('/api/ledger', ledgerRouter);
//
// Requires an environment variable LEDGER_API_KEY set on the DO server
// (e.g. in your PM2 ecosystem file or a .env loaded via dotenv).
// Every request must include header:  x-ledger-key: <LEDGER_API_KEY>

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('./ledger-db');

// A Free Bet is SNR (Stake Not Returned) — no real money was ever staked, so it should
// never deduct from an account's balance at creation, and only its winnings (never the
// notional stake) should land in the balance at settlement. Checked from the bet's own
// stored fields, so it applies consistently everywhere a 'Bet Type' field exists (Offers,
// Other Bets, or any future tab that adds the same option).
function isFreeBetFields(fieldsJsonOrObj) {
  try {
    const f = typeof fieldsJsonOrObj === 'string' ? JSON.parse(fieldsJsonOrObj) : fieldsJsonOrObj;
    return f && f['Bet Type'] === 'Free Bet';
  } catch { return false; }
}

// Casino's leg 'stake' is a purely nominal value (£0.01) used only to link the bet to an
// account — never real money. Combined with the free-bet check below, this determines
// whether a stake component should ever touch account balance at all.
function isCasinoType(bet_type) {
  return bet_type === 'Casino' || bet_type === 'Casino (Personal)';
}
function hasNoRealStake(bet_type, fieldsJsonOrObj) {
  return isCasinoType(bet_type) || isFreeBetFields(fieldsJsonOrObj);
}

// How much of a Back & Lay leg's balance effect is actually "committed" at placement/
// settlement time — a back leg commits its stake (same as every other bet type), but a lay
// leg commits its *liability* (stake × (odds-1)), since that's the amount the exchange
// account actually has locked up, not the lay stake itself. NULL role (every other bet
// type) always falls through to the plain stake, so this is a no-op everywhere else.
function legCommitted(leg) {
  return leg.role === 'lay' ? leg.stake * (leg.odds - 1) : leg.stake;
}

// Mirrors the frontend's BET_TYPE_GROUPS, for server-side enforcement of the
// Staff-can-only-use-Assistant restriction. Custom sheets aren't hardcoded here — their
// group is looked up from custom_sheets.user_group instead.
const HARDCODED_BUZZER_TYPES = [
  'Value', 'Keithbot', 'Dogs + Horses', 'BB Horse', 'BB Golf', 'American Props', 'Freeze',
  'Ninja Golf BFEX', 'Corners', 'Offers (Personal)', 'Other Bets', 'Casino (Personal)', 'Back & Lay'
];
const HARDCODED_ASSISTANT_TYPES = ['Discord', 'BB - RTP', 'BB - BT', 'Casino', 'Offers (VA)', 'Dogs + Horses (VA)'];
function getBetTypeGroup(bet_type) {
  if (HARDCODED_BUZZER_TYPES.includes(bet_type)) return 'buzzer';
  if (HARDCODED_ASSISTANT_TYPES.includes(bet_type)) return 'assistant';
  const custom = db.prepare(`SELECT user_group FROM custom_sheets WHERE key = ?`).get(bet_type);
  return custom ? custom.user_group : null; // null = unknown type, let it through rather than guess wrong
}

// ---- passcode hashing (Node's built-in crypto, no extra dependency) ----
function hashPasscode(passcode, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(passcode, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPasscode(passcode, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(passcode, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

// ---- auth (server-level gate — unchanged) ----
router.use((req, res, next) => {
  const key = req.headers['x-ledger-key'];
  if (!process.env.LEDGER_API_KEY) {
    return res.status(500).json({ ok: false, error: 'LEDGER_API_KEY not configured on server' });
  }
  if (key !== process.env.LEDGER_API_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
});

router.use(express.json());

// ---- session resolution (per-user identity, layered on top of the server-level gate
// above) — attaches req.userRole/req.username if a valid session token is present, but
// does NOT reject the request if absent. Only specific routes (via requireAdmin below)
// actually require a resolved session; most read-only routes work regardless, matching
// how the app worked before logins existed.
router.use((req, res, next) => {
  const token = req.headers['x-session-token'];
  if (token) {
    const session = db.prepare(`SELECT * FROM sessions WHERE token = ?`).get(token);
    if (session) { req.username = session.username; req.userRole = session.role; }
  }
  next();
});

// The Calculator role can only ever use the Calculations tools, which don't touch any
// live betting/financial data — so it has no legitimate reason to ever call this API at
// all. Blocked entirely here, not just hidden in the frontend, so there's no endpoint a
// Calculator session could reach even by calling the API directly.
// Exception: /fotmob-leagues lives under this router for historical/routing reasons only —
// it's part of the Calculations feature set (Today's Matches / Edit Leagues), not financial
// Ledger data, so it's exempted from this block rather than widening Calculator's access
// generally. /notifications is likewise exempt — the header notification bell is available
// to every role, and the route itself only ever returns 'all'-audience rows to a Calculator.
router.use((req, res, next) => {
  if (req.userRole === 'calculator'
      && !req.path.startsWith('/fotmob-leagues')
      && !req.path.startsWith('/notifications')
      && !req.path.startsWith('/match-predictions')) {
    return res.status(403).json({ ok: false, error: 'This account has no access to the Ledger.' });
  }
  next();
});

// Blocks the request unless the session resolved to an admin. Used on every action that
// should be Admin-only regardless of what the frontend UI shows or hides.
function requireAdmin(req, res, next) {
  if (req.userRole !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required for this action.' });
  next();
}

// POST /api/ledger/login — body: { username, passcode }
router.post('/login', (req, res) => {
  try {
    const { username, passcode } = req.body;
    if (!username || !passcode) return res.status(400).json({ ok: false, error: 'username and passcode are required' });
    const user = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username);
    if (!user || !verifyPasscode(passcode, user.passcode_hash)) {
      return res.status(401).json({ ok: false, error: 'Incorrect username or passcode' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO sessions (token, username, role) VALUES (?, ?, ?)`).run(token, user.username, user.role);
    res.json({ ok: true, token, role: user.role, username: user.username });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});



function openStakeFor(accountId) {
  const rows = db.prepare(
    `SELECT bl.stake, b.bet_type, b.fields FROM bet_legs bl JOIN bets b ON b.id = bl.bet_id WHERE bl.account_id = ? AND bl.settled = 0`
  ).all(accountId);
  return rows.reduce((sum, r) => hasNoRealStake(r.bet_type, r.fields) ? sum : sum + r.stake, 0);
}

// ================== ACCOUNTS ==================

// GET /api/ledger/accounts — full grid with live + open-stake balances
// GET /api/ledger/accounts?excludeClosed=1 — full list with live + open-stake balances.
// Live Accounts uses excludeClosed=1; Account Summary and other reporting wants everything.
// GET /api/ledger/accounts/next-id?prefix=D  (or C)
// Returns the next unused number for that prefix, based on the highest one ever assigned
// (regardless of bookie or status) — so it never suggests an ID that's already in use.
router.get('/accounts/next-id', (req, res) => {
  try {
    const prefix = (req.query.prefix || '').toUpperCase();
    if (!['C', 'D'].includes(prefix)) return res.status(400).json({ ok: false, error: 'prefix must be C or D' });
    const rows = db.prepare(`SELECT account_id FROM accounts WHERE account_id LIKE ?`).all(prefix + '%');
    let max = 0;
    rows.forEach(r => {
      const m = String(r.account_id).match(new RegExp(`^${prefix}(\\d+)$`, 'i'));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    const next = String(max + 1).padStart(3, '0');
    res.json({ ok: true, next_id: prefix + next });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Computes each account's last-activity date across deposits, withdrawals, and bets in
// three single aggregate queries (not one query per account, which wouldn't scale) — used
// to flag accounts sitting dormant with real money still in them.
function computeLastActivityMap() {
  const map = {};
  const bump = (accountId, date) => { if (!map[accountId] || date > map[accountId]) map[accountId] = date; };
  db.prepare(`SELECT account_id, MAX(date) AS last FROM deposits GROUP BY account_id`).all().forEach(r => bump(r.account_id, r.last));
  db.prepare(`SELECT account_id, MAX(date) AS last FROM withdrawals GROUP BY account_id`).all().forEach(r => bump(r.account_id, r.last));
  db.prepare(`SELECT bl.account_id, MAX(b.date) AS last FROM bet_legs bl JOIN bets b ON b.id = bl.bet_id GROUP BY bl.account_id`).all().forEach(r => bump(r.account_id, r.last));
  return map;
}

router.get('/accounts', (req, res) => {
  try {
    const query = req.query.excludeClosed
      ? `SELECT * FROM accounts WHERE status NOT IN ('closed','locked') ORDER BY bookie, profile`
      : `SELECT * FROM accounts ORDER BY bookie, profile`;
    const accounts = db.prepare(query).all();
    // Most recent note per account — the notes UI treats this as effectively one note per
    // account (edit/delete, not a growing history), so this is what "the" note means here.
    const latestNoteStmt = db.prepare(`SELECT text FROM account_notes WHERE account_id = ? ORDER BY created_at DESC LIMIT 1`);
    const lastActivity = computeLastActivityMap();
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const withExtras = accounts.map(a => {
      const last = lastActivity[a.id] || a.created_at; // never used at all — dormant clock starts from when it was created
      const isDormant = a.status === 'good' && a.balance > 0 && last < sixtyDaysAgo;
      const latestNote = latestNoteStmt.get(a.id);
      return { ...a, open_stake: openStakeFor(a.id), has_notes: !!latestNote, note_text: latestNote ? latestNote.text : null, is_dormant: isDormant, last_activity: last };
    });
    res.json({ ok: true, accounts: withExtras });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/accounts — create a new profile x bookie account
// body: { profile, bookie, account_name?, label?, status?, note? }
// `label` disambiguates two+ accounts on the same profile+bookie (e.g. '#1'/'#2', a nickname) —
// duplicates on profile+bookie are allowed by design (multiple live accounts can exist at once).
// Validates account_id uniqueness rules before creating an account:
//   D-series (D001, D014, ...) — globally unique forever, regardless of bookie.
//   C-series (C001, ...)       — unique per bookie only; the same C-ID can be used
//                                 across different bookies, just not twice for one bookie.
//   Anything else              — treated like C-series (unique per bookie) as a safe default.
// Closed accounts are included in this check (their rows are kept, not deleted).
function validateAccountId(accountId, bookie) {
  if (!accountId) return null; // account_id is optional for now, so skip if not given
  const isD = /^D\d+$/i.test(accountId);
  if (isD) {
    const existing = db.prepare(`SELECT bookie FROM accounts WHERE account_id = ?`).get(accountId);
    if (existing) return `${accountId} has already been used (for ${existing.bookie}) — D-series IDs can only ever be used once.`;
  } else {
    const existing = db.prepare(`SELECT bookie FROM accounts WHERE account_id = ? AND bookie = ?`).get(accountId, bookie);
    if (existing) return `${accountId} has already been used for ${bookie}.`;
  }
  return null; // no error
}

// ================== CARDS (physical/virtual deposit cards, C-series) ==================
// GET /api/ledger/cards — optional ?availableForBookie=X excludes cards already used for
// that specific bookie (the same card can back accounts at other bookies, just not twice
// at the same one).
router.get('/cards', (req, res) => {
  try {
    const cards = db.prepare(`SELECT * FROM cards ORDER BY card_number`).all();
    const { availableForBookie } = req.query;
    if (!availableForBookie) return res.json({ ok: true, cards });
    const usedNumbers = new Set(
      db.prepare(`SELECT account_id FROM accounts WHERE bookie = ?`).all(availableForBookie).map(r => r.account_id)
    );
    res.json({ ok: true, cards: cards.filter(c => !usedNumbers.has(c.card_number)) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/cards — body: { bank }. Auto-assigns the next available C-number.
router.post('/cards', (req, res) => {
  try {
    const { bank } = req.body;
    if (!bank || !bank.trim()) return res.status(400).json({ ok: false, error: 'bank is required' });
    const existing = db.prepare(`SELECT card_number FROM cards`).all().map(r => r.card_number);
    let n = 1;
    while (existing.includes('C' + String(n).padStart(3, '0'))) n++;
    const cardNumber = 'C' + String(n).padStart(3, '0');
    db.prepare(`INSERT INTO cards (card_number, bank) VALUES (?, ?)`).run(cardNumber, bank.trim());
    res.json({ ok: true, card_number: cardNumber });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/accounts/:id/rename-id — temporary correction tool for migrating the
// existing account pool onto the new shared-card model. Bypasses nothing important: still
// runs through the same validateAccountId rule (same bookie can't have the same ID twice),
// just allows changing account_id directly, which the normal account PATCH doesn't.
router.patch('/accounts/:id/rename-id', (req, res) => {
  try {
    const { account_id } = req.body;
    if (!account_id || !account_id.trim()) return res.status(400).json({ ok: false, error: 'account_id is required' });
    const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(req.params.id);
    if (!account) return res.status(404).json({ ok: false, error: 'Account not found' });
    const newId = account_id.trim();
    if (newId !== account.account_id) {
      const isD = /^D\d+$/i.test(newId);
      const clash = isD
        ? db.prepare(`SELECT bookie FROM accounts WHERE account_id = ? AND id != ?`).get(newId, req.params.id)
        : db.prepare(`SELECT bookie FROM accounts WHERE account_id = ? AND bookie = ? AND id != ?`).get(newId, account.bookie, req.params.id);
      if (clash) return res.status(409).json({ ok: false, error: `${newId} is already used for ${clash.bookie}.` });
    }
    db.prepare(`UPDATE accounts SET account_id = ?, updated_at = datetime('now') WHERE id = ?`).run(newId, req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

router.post('/accounts', (req, res) => {
  try {
    const { profile, bookie, account_name = '', label = '', status = 'good', note = '', account_id = null, balance = 0 } = req.body;
    if (!profile || !bookie) return res.status(400).json({ ok: false, error: 'profile and bookie required' });
    const idError = validateAccountId(account_id, bookie);
    if (idError) return res.status(409).json({ ok: false, error: idError });
    const stmt = db.prepare(
      `INSERT INTO accounts (account_id, profile, bookie, account_name, label, status, note, balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const info = stmt.run(account_id, profile, bookie, account_name, label, status, note, balance);
    const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(info.lastInsertRowid);
    res.json({ ok: true, account });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/ledger/accounts/publish — the new Account Entry flow. No Sheet writes at all —
// this is a pure database operation, since the old Accounts-sheet grid concept is retired.
// body (single):  { account_id, bookie, bank, balance? }
// body (bulk):    { accounts: [ { account_id, bookie, bank, balance? }, ... ] }
// `bank` maps to the `profile` column (repurposed). Every entry is validated independently;
// bulk requests return a per-row result so one bad ID doesn't block the rest of the batch.
router.post('/accounts/publish', (req, res) => {
  try {
    const list = Array.isArray(req.body.accounts) ? req.body.accounts : [req.body];
    const results = [];
    for (const entry of list) {
      const { account_id, bookie, bank, balance = 0 } = entry;
      if (!account_id || !bookie || !bank) {
        results.push({ ok: false, account_id, bookie, error: 'account_id, bookie and bank are all required' });
        continue;
      }
      const idError = validateAccountId(account_id, bookie);
      if (idError) { results.push({ ok: false, account_id, bookie, error: idError }); continue; }
      try {
        const startBal = parseFloat(balance) || 0;
        const info = db.prepare(
          `INSERT INTO accounts (account_id, profile, bookie, status, balance, starting_balance) VALUES (?, ?, ?, 'good', ?, ?)`
        ).run(account_id, bank, bookie, startBal, startBal);
        results.push({ ok: true, account_id, bookie, id: info.lastInsertRowid });
      } catch (err) {
        results.push({ ok: false, account_id, bookie, error: err.message });
      }
    }
    res.json({ ok: true, results });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ================== BANKS ==================
// A bank's balance is a genuinely independent, directly-stored figure — NOT derived from
// account balances. It only changes via: setting/overriding it directly, a deposit (money
// leaving the bank pool into an account), a withdrawal (money returning to the pool), or a
// manual bank transaction. Bet P/L, account creation with a pre-existing float, and locking
// an account never touch it — those only ever affect the account itself.

// GET /api/ledger/banks
router.get('/banks', (req, res) => {
  try {
    const banks = db.prepare(`SELECT * FROM banks ORDER BY name`).all();
    const result = banks.map(b => {
      const lockedTotal = db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM locked_funds WHERE bank = ?`).get(b.name).t;
      return { name: b.name, starting_balance: b.starting_balance, remaining: b.starting_balance, locked_total: lockedTotal };
    });
    res.json({ ok: true, banks: result });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/banks — create or update a bank's starting balance
// body: { name, starting_balance }
router.post('/banks', requireAdmin, (req, res) => {
  try {
    const { name, starting_balance = 0 } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ ok: false, error: 'name required' });
    db.prepare(
      `INSERT INTO banks (name, starting_balance) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET starting_balance = excluded.starting_balance`
    ).run(name.trim(), parseFloat(starting_balance) || 0);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// DELETE /api/ledger/banks/:name — blocked if any live (non-closed, non-locked) account
// is still linked to this bank.
router.delete('/banks/:name', (req, res) => {
  try {
    const name = req.params.name;
    const liveCount = db.prepare(
      `SELECT COUNT(*) c FROM accounts WHERE profile = ? AND status NOT IN ('closed','locked')`
    ).get(name).c;
    if (liveCount > 0) {
      return res.status(409).json({ ok: false, error: `Can't delete — ${liveCount} live account(s) are still linked to this bank.` });
    }
    db.prepare(`DELETE FROM banks WHERE name = ?`).run(name);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/banks/:name/rename — body: { newName }
// A bank's name is a natural key referenced across several other tables — this updates all
// of them atomically so nothing ends up pointing at the old name.
router.patch('/banks/:name/rename', (req, res) => {
  const oldName = req.params.name;
  const newName = (req.body.newName || '').trim();
  const doRename = db.transaction(() => {
    const existing = db.prepare(`SELECT 1 FROM banks WHERE name = ?`).get(oldName);
    if (!existing) throw new Error('Bank not found');
    if (newName !== oldName) {
      const clash = db.prepare(`SELECT 1 FROM banks WHERE name = ?`).get(newName);
      if (clash) throw new Error(`A bank named "${newName}" already exists`);
    }
    db.prepare(`UPDATE banks SET name = ? WHERE name = ?`).run(newName, oldName);
    db.prepare(`UPDATE accounts SET profile = ? WHERE profile = ?`).run(newName, oldName);
    db.prepare(`UPDATE bank_transactions SET bank = ? WHERE bank = ?`).run(newName, oldName);
    db.prepare(`UPDATE bank_transfers SET from_bank = ? WHERE from_bank = ?`).run(newName, oldName);
    db.prepare(`UPDATE bank_transfers SET to_bank = ? WHERE to_bank = ?`).run(newName, oldName);
    db.prepare(`UPDATE locked_funds SET bank = ? WHERE bank = ?`).run(newName, oldName);
  });
  try {
    if (!newName) return res.status(400).json({ ok: false, error: 'newName required' });
    doRename();
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// ================== BANK TRANSACTIONS ==================
// Direct money movement in/out of a bank's own pool — not via any betting account.
// Adjusts the bank's starting_balance directly, which is what "remaining" is derived from.

// GET /api/ledger/bank-transactions
router.get('/bank-transactions', requireAdmin, (req, res) => {
  try {
    const rows = db.prepare(`SELECT * FROM bank_transactions ORDER BY created_at DESC LIMIT 500`).all();
    res.json({ ok: true, transactions: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/bank-transactions — body: { bank, amount, direction: 'in'|'out', reason? }
router.post('/bank-transactions', requireAdmin, (req, res) => {
  const doTransaction = db.transaction((bank, amount, direction, reason) => {
    const b = db.prepare(`SELECT * FROM banks WHERE name = ?`).get(bank);
    if (!b) throw new Error('Bank not found');
    const delta = direction === 'in' ? amount : -amount;
    db.prepare(`UPDATE banks SET starting_balance = starting_balance + ? WHERE name = ?`).run(delta, bank);
    const info = db.prepare(`INSERT INTO bank_transactions (bank, amount, direction, reason) VALUES (?, ?, ?, ?)`).run(bank, amount, direction, reason || '');
    return info.lastInsertRowid;
  });
  try {
    const { bank, amount, direction, reason } = req.body;
    const amt = parseFloat(amount);
    if (!bank) return res.status(400).json({ ok: false, error: 'bank required' });
    if (!(amt > 0)) return res.status(400).json({ ok: false, error: 'amount must be a positive number' });
    if (!['in', 'out'].includes(direction)) return res.status(400).json({ ok: false, error: 'direction must be in or out' });
    const id = doTransaction(bank, amt, direction, reason);
    res.json({ ok: true, id });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// DELETE /api/ledger/bank-transactions/:id — undoes it: reverses the balance adjustment
// (opposite direction of the original) and removes the record.
router.delete('/bank-transactions/:id', requireAdmin, (req, res) => {
  const doUndo = db.transaction((id) => {
    const txn = db.prepare(`SELECT * FROM bank_transactions WHERE id = ?`).get(id);
    if (!txn) throw new Error('Transaction not found');
    const delta = txn.direction === 'in' ? -txn.amount : txn.amount;
    db.prepare(`UPDATE banks SET starting_balance = starting_balance + ? WHERE name = ?`).run(delta, txn.bank);
    db.prepare(`DELETE FROM bank_transactions WHERE id = ?`).run(id);
  });
  try {
    doUndo(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/bank-transactions/:id — corrects the amount. Reverses the old delta and
// applies the new one, rather than assuming a wholesale re-derivation.
router.patch('/bank-transactions/:id', requireAdmin, (req, res) => {
  const doEdit = db.transaction((id, newAmount) => {
    const txn = db.prepare(`SELECT * FROM bank_transactions WHERE id = ?`).get(id);
    if (!txn) throw new Error('Transaction not found');
    const oldDelta = txn.direction === 'in' ? txn.amount : -txn.amount;
    const newDelta = txn.direction === 'in' ? newAmount : -newAmount;
    db.prepare(`UPDATE banks SET starting_balance = starting_balance - ? + ? WHERE name = ?`).run(oldDelta, newDelta, txn.bank);
    db.prepare(`UPDATE bank_transactions SET amount = ? WHERE id = ?`).run(newAmount, id);
  });
  try {
    const newAmount = parseFloat(req.body.amount);
    if (!(newAmount > 0)) return res.status(400).json({ ok: false, error: 'amount must be a positive number' });
    doEdit(req.params.id, newAmount);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// ================== BANK TRANSFERS (money between two banks on the site) ==================
router.get('/bank-transfers', requireAdmin, (req, res) => {
  try {
    const rows = db.prepare(`SELECT * FROM bank_transfers ORDER BY created_at DESC LIMIT 500`).all();
    res.json({ ok: true, transfers: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/bank-transfers — body: { from_bank, to_bank, amount }
router.post('/bank-transfers', requireAdmin, (req, res) => {
  const doTransfer = db.transaction((fromBank, toBank, amount) => {
    const from = db.prepare(`SELECT * FROM banks WHERE name = ?`).get(fromBank);
    if (!from) throw new Error('Sending bank not found');
    const to = db.prepare(`SELECT * FROM banks WHERE name = ?`).get(toBank);
    if (!to) throw new Error('Receiving bank not found');
    db.prepare(`UPDATE banks SET starting_balance = starting_balance - ? WHERE name = ?`).run(amount, fromBank);
    db.prepare(`UPDATE banks SET starting_balance = starting_balance + ? WHERE name = ?`).run(amount, toBank);
    const info = db.prepare(`INSERT INTO bank_transfers (from_bank, to_bank, amount) VALUES (?, ?, ?)`).run(fromBank, toBank, amount);
    return info.lastInsertRowid;
  });
  try {
    const { from_bank, to_bank, amount } = req.body;
    const amt = parseFloat(amount);
    if (!from_bank || !to_bank) return res.status(400).json({ ok: false, error: 'both banks are required' });
    if (from_bank === to_bank) return res.status(400).json({ ok: false, error: 'sending and receiving bank must be different' });
    if (!(amt > 0)) return res.status(400).json({ ok: false, error: 'amount must be a positive number' });
    const id = doTransfer(from_bank, to_bank, amt);
    res.json({ ok: true, id });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// DELETE /api/ledger/bank-transfers/:id — reverses both sides of the transfer atomically
// and removes the record.
router.delete('/bank-transfers/:id', requireAdmin, (req, res) => {
  const doUndo = db.transaction((id) => {
    const t = db.prepare(`SELECT * FROM bank_transfers WHERE id = ?`).get(id);
    if (!t) throw new Error('Transfer not found');
    db.prepare(`UPDATE banks SET starting_balance = starting_balance + ? WHERE name = ?`).run(t.amount, t.from_bank);
    db.prepare(`UPDATE banks SET starting_balance = starting_balance - ? WHERE name = ?`).run(t.amount, t.to_bank);
    db.prepare(`DELETE FROM bank_transfers WHERE id = ?`).run(id);
  });
  try {
    doUndo(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/bank-transfers/:id — corrects the amount, adjusting both banks by the
// difference in the correct opposite directions.
router.patch('/bank-transfers/:id', requireAdmin, (req, res) => {
  const doEdit = db.transaction((id, newAmount) => {
    const t = db.prepare(`SELECT * FROM bank_transfers WHERE id = ?`).get(id);
    if (!t) throw new Error('Transfer not found');
    const diff = newAmount - t.amount;
    db.prepare(`UPDATE banks SET starting_balance = starting_balance - ? WHERE name = ?`).run(diff, t.from_bank);
    db.prepare(`UPDATE banks SET starting_balance = starting_balance + ? WHERE name = ?`).run(diff, t.to_bank);
    db.prepare(`UPDATE bank_transfers SET amount = ? WHERE id = ?`).run(newAmount, id);
  });
  try {
    const newAmount = parseFloat(req.body.amount);
    if (!(newAmount > 0)) return res.status(400).json({ ok: false, error: 'amount must be a positive number' });
    doEdit(req.params.id, newAmount);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/accounts/:id — update status, note, label, account_name, and/or balance
// body: { status?, note?, label?, account_name?, balance? }
// `balance` is a direct manual override (e.g. setting a real starting balance on an account
// that already had funds when it was first added) — it does not create a deposit/withdrawal
// record, it just sets the number directly.
// `closed_at` is managed automatically here, not passed in: stamped when status becomes
// 'closed', cleared when it becomes anything else (e.g. restored from the archive).
router.patch('/accounts/:id', (req, res) => {
  const doUpdate = db.transaction((id, status, note, label, account_name, balance, username) => {
    const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id);
    if (!account) throw new Error('Account not found');
    let closedAt = undefined; // undefined = don't touch
    if (status === 'closed') closedAt = new Date().toISOString();
    else if (status) closedAt = null; // any other explicit status clears it
    db.prepare(
      `UPDATE accounts SET status = COALESCE(?, status), note = COALESCE(?, note), label = COALESCE(?, label), account_name = COALESCE(?, account_name), balance = COALESCE(?, balance), closed_at = CASE WHEN ? THEN ? ELSE closed_at END, updated_at = datetime('now') WHERE id = ?`
    ).run(status ?? null, note ?? null, label ?? null, account_name ?? null, (typeof balance === 'number' ? balance : null), closedAt !== undefined ? 1 : 0, closedAt ?? null, id);
    if (typeof balance === 'number' && balance !== account.balance) {
      db.prepare(`INSERT INTO manual_adjustments (account_id, old_balance, new_balance, delta, created_by) VALUES (?, ?, ?, ?, ?)`)
        .run(id, account.balance, balance, balance - account.balance, username || null);
    }
    return db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id);
  });
  try {
    const { status, note, label, account_name, balance } = req.body;
    if (typeof balance === 'number' && balance < 0) return res.status(400).json({ ok: false, error: 'Balance cannot be set below £0' });
    const updated = doUpdate(req.params.id, status, note, label, account_name, balance, req.username);
    res.json({ ok: true, account: updated });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// GET /api/ledger/accounts/recently-closed — accounts marked Finished within the last 7 days,
// for the undo window. Uses closed_at specifically, not updated_at (which unrelated edits
// like deposits also touch).
router.get('/accounts/recently-closed', (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT * FROM accounts WHERE status = 'closed' AND closed_at >= datetime('now','-7 days') ORDER BY closed_at DESC`
    ).all();
    res.json({ ok: true, accounts: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/accounts/:id/lock — moves the account's current live balance into
// Locked Funds and zeroes the account's balance. Does not close/finish the account.
router.post('/accounts/:id/lock', (req, res) => {
  const doLock = db.transaction((accountId) => {
    const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
    if (!account) throw new Error('Account not found');
    if (!(account.balance > 0)) throw new Error('No live balance to lock');
    db.prepare(`INSERT INTO locked_funds (account_code, bookie, bank, amount, source, linked_account_id) VALUES (?, ?, ?, ?, 'account_locked', ?)`)
      .run(account.account_id, account.bookie, account.profile, account.balance, accountId);
    db.prepare(`UPDATE accounts SET balance = 0, status = 'locked', updated_at = datetime('now') WHERE id = ?`).run(accountId);
    return account.balance;
  });
  try {
    const lockedAmount = doLock(req.params.id);
    res.json({ ok: true, lockedAmount });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/locked-funds/:id/unlock — only valid for 'account_locked' entries.
// Restores the exact original account: adds the amount back to its balance and sets its
// status back to 'good' (reappearing on Live Accounts), then removes the locked-funds row.
router.post('/locked-funds/:id/unlock', (req, res) => {
  const doUnlock = db.transaction((id) => {
    const lf = db.prepare(`SELECT * FROM locked_funds WHERE id = ?`).get(id);
    if (!lf) throw new Error('Locked funds record not found');
    if (lf.source !== 'account_locked' || !lf.linked_account_id) throw new Error('This entry has no linked account to restore');
    const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(lf.linked_account_id);
    if (!account) throw new Error('Original account no longer exists');
    db.prepare(`UPDATE accounts SET balance = balance + ?, status = 'good', updated_at = datetime('now') WHERE id = ?`).run(lf.amount, lf.linked_account_id);
    db.prepare(`DELETE FROM locked_funds WHERE id = ?`).run(id);
  });
  try {
    doUnlock(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// DELETE /api/ledger/locked-funds/:id — simple removal, no side effects on any account.
// POST /api/ledger/locked-funds/:id/recover — only valid for 'confiscated_withdrawal'
// entries with a still-existing linked account. The bookie decided to pay out after all —
// restores the amount to the account (undoing what confiscation deducted) and recreates a
// pending withdrawal for the same amount. The bank is deliberately NOT touched here — if
// this recreated withdrawal later gets confirmed, that step will correctly credit the bank
// then, exactly like any other pending withdrawal.
router.post('/locked-funds/:id/recover', (req, res) => {
  const doRecover = db.transaction((id) => {
    const lf = db.prepare(`SELECT * FROM locked_funds WHERE id = ?`).get(id);
    if (!lf) throw new Error('Locked funds record not found');
    if (lf.source !== 'confiscated_withdrawal' || !lf.linked_account_id) throw new Error('This entry has no linked account to recover to');
    const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(lf.linked_account_id);
    if (!account) throw new Error('Original account no longer exists');
    if (account.status === 'closed') throw new Error('Original account is Finished — cannot recreate a pending withdrawal against it');
    // No account balance change here — it's already reflecting the deduction from when
    // this withdrawal was originally requested, and stays deducted through recovery, same
    // as it did through confiscation. This just recreates the pending record for the same
    // money.
    const info = db.prepare(`INSERT INTO withdrawals (account_id, amount, balance_after, status) VALUES (?, ?, ?, 'pending')`)
      .run(lf.linked_account_id, lf.amount, account.balance);
    db.prepare(`DELETE FROM locked_funds WHERE id = ?`).run(id);
    return info.lastInsertRowid;
  });
  try {
    const withdrawalId = doRecover(req.params.id);
    res.json({ ok: true, withdrawalId });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

router.delete('/locked-funds/:id', (req, res) => {
  try {
    db.prepare(`DELETE FROM locked_funds WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// GET /api/ledger/locked-funds
router.get('/locked-funds', (req, res) => {
  try {
    const rows = db.prepare(`SELECT * FROM locked_funds ORDER BY created_at DESC`).all();
    res.json({ ok: true, locked: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// GET /api/ledger/accounts/:id — single account detail (for the click-to-expand cell)
router.get('/accounts/:id', (req, res) => {
  try {
    const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(req.params.id);
    if (!account) return res.status(404).json({ ok: false, error: 'Account not found' });
    account.open_stake = openStakeFor(account.id);
    res.json({ ok: true, account });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// GET /api/ledger/accounts/:id/notes
// GET /api/ledger/accounts/:id/full-transactions?month=YYYY-MM or ?date=YYYY-MM-DD
//   &type=deposits|withdrawals|bets — optional, combinable with month/date
// Every event that's ever moved this account's balance by a penny, in one unified list:
// deposits, withdrawals (deducted at request time under the current model, so shown
// regardless of pending/confirmed status), bet placement (stake leaving), bet settlement
// (credit back), and a withdrawal being reversed (the refund back to the account). Free-bet
// /Casino nominal-stake legs are correctly excluded from the placement event, matching how
// they never touch real balance anywhere else in the app.
//
// Running balance is computed working backwards from the account's current, trusted live
// balance — anchored to a known-correct number rather than summed forward from an
// arbitrary starting point, which could drift if any historical data is incomplete.
router.get('/accounts/:id/full-transactions', (req, res) => {
  try {
    const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(req.params.id);
    if (!account) return res.status(404).json({ ok: false, error: 'Account not found' });

    const events = [];

    db.prepare(`SELECT * FROM deposits WHERE account_id = ?`).all(req.params.id).forEach(d => {
      events.push({ date: d.date, type: 'Deposit', amount: d.amount, odds: null, stake: null, betType: null, sourceType: 'deposit', sourceId: d.id });
    });

    db.prepare(`SELECT * FROM withdrawals WHERE account_id = ?`).all(req.params.id).forEach(w => {
      events.push({ date: w.date, type: 'Withdrawal', amount: -w.amount, odds: null, stake: null, betType: null, sourceType: 'withdrawal', sourceId: w.id, alreadyReversed: w.status === 'reversed' });
      if (w.status === 'reversed' && w.reversed_at) {
        events.push({ date: w.reversed_at, type: 'Withdrawal reversed', amount: w.amount, odds: null, stake: null, betType: null, sourceType: null, sourceId: null });
      }
    });

    db.prepare(`SELECT * FROM manual_adjustments WHERE account_id = ?`).all(req.params.id).forEach(a => {
      events.push({ date: a.date, type: 'Manual adjustment', amount: a.delta, odds: null, stake: null, betType: null, sourceType: 'manual_adjustment', sourceId: a.id });
    });

    const legs = db.prepare(
      `SELECT bl.*, b.date AS bet_date, b.settled_at, b.bet_type, b.fields
       FROM bet_legs bl JOIN bets b ON b.id = bl.bet_id WHERE bl.account_id = ?`
    ).all(req.params.id);
    legs.forEach(leg => {
      const fields = JSON.parse(leg.fields);
      const freeBet = hasNoRealStake(leg.bet_type, fields);
      const odds = typeof fields.Odds === 'number' ? fields.Odds : null;
      if (!freeBet) {
        events.push({ date: leg.bet_date, type: 'Bet placed', amount: -leg.stake, odds, stake: leg.stake, betType: leg.bet_type, sourceType: 'bet', sourceId: leg.bet_id });
      }
      if (leg.settled && leg.settled_at) {
        const stakeComponent = freeBet ? 0 : leg.stake;
        const creditBack = stakeComponent + (leg.leg_pl || 0);
        events.push({ date: leg.settled_at, type: 'Bet settled', amount: creditBack, odds, stake: leg.stake, betType: leg.bet_type, sourceType: 'bet_settlement', sourceId: leg.bet_id });
      }
    });

    events.sort((a, b) => new Date(b.date) - new Date(a.date));

    let running = account.balance;
    events.forEach(e => {
      e.balanceAfter = +running.toFixed(2);
      running = +(running - e.amount).toFixed(2);
    });

    const { month, date, type } = req.query;
    let filtered = events;
    if (date) filtered = events.filter(e => e.date.slice(0, 10) === date);
    else if (month) filtered = events.filter(e => e.date.slice(0, 7) === month);

    // Optional transaction-type filter, combinable with the month/date filter above.
    const TYPE_GROUPS = {
      deposits: ['Deposit'],
      withdrawals: ['Withdrawal', 'Withdrawal reversed'],
      bets: ['Bet placed', 'Bet settled'],
    };
    if (type && TYPE_GROUPS[type]) filtered = filtered.filter(e => TYPE_GROUPS[type].includes(e.type));

    res.json({ ok: true, transactions: filtered.slice(0, 50), totalMatching: filtered.length });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// DELETE /api/ledger/manual-adjustments/:id — reverses the account balance change and
// removes the log row entirely, same "undo and delete the record" pattern as reversing a
// deposit or withdrawal.
// GET /api/ledger/manual-adjustments — every manual balance override across every account,
// most recent first. Powers the dedicated Manual Adjustment Log page.
router.get('/manual-adjustments', (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT ma.*, a.account_id AS card_id, a.bookie
       FROM manual_adjustments ma JOIN accounts a ON a.id = ma.account_id
       ORDER BY ma.date DESC LIMIT 500`
    ).all();
    res.json({ ok: true, adjustments: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.delete('/manual-adjustments/:id', (req, res) => {
  const doReverse = db.transaction((id) => {
    const adj = db.prepare(`SELECT * FROM manual_adjustments WHERE id = ?`).get(id);
    if (!adj) throw new Error('Adjustment not found');
    db.prepare(`UPDATE accounts SET balance = balance - ?, updated_at = datetime('now') WHERE id = ?`).run(adj.delta, adj.account_id);
    db.prepare(`DELETE FROM manual_adjustments WHERE id = ?`).run(id);
  });
  try {
    doReverse(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// GET /api/ledger/accounts/:id/open-bets — powers the Settlement tab on the account modal.
// Non-Casino open bets get full detail (date, type, fields, odds, stake) for settling
// directly from here. Casino is handled separately — since it settles automatically once
// its balance fields are filled in rather than through a normal Settle action, there's
// nothing meaningful to show per-bet here — just a count of how many are still unfinished.
router.get('/accounts/:id/open-bets', (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT b.id, b.bet_type, b.date, b.fields, bl.stake
       FROM bet_legs bl JOIN bets b ON b.id = bl.bet_id
       WHERE bl.account_id = ? AND bl.settled = 0 AND b.bet_type NOT IN ('Casino', 'Casino (Personal)')
       ORDER BY b.date DESC`
    ).all(req.params.id);
    const openBets = rows.map(r => ({ id: r.id, bet_type: r.bet_type, date: r.date, stake: r.stake, fields: JSON.parse(r.fields) }));

    const casinoUnfinishedCount = db.prepare(
      `SELECT COUNT(*) AS n FROM bets WHERE id IN (SELECT bet_id FROM bet_legs WHERE account_id = ?) AND bet_type IN ('Casino', 'Casino (Personal)') AND result = 'open'`
    ).get(req.params.id).n;

    res.json({ ok: true, openBets, casinoUnfinishedCount });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/accounts/:id/notes', (req, res) => {
  try {
    const notes = db.prepare(`SELECT * FROM account_notes WHERE account_id = ? ORDER BY created_at DESC`).all(req.params.id);
    res.json({ ok: true, notes });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/accounts/:id/notes — body: { text }
router.post('/accounts/:id/notes', (req, res) => {
  try {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'Note text is required' });
    const info = db.prepare(`INSERT INTO account_notes (account_id, text) VALUES (?, ?)`).run(req.params.id, text);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// DELETE /api/ledger/account-notes/:id
router.delete('/account-notes/:id', (req, res) => {
  try {
    db.prepare(`DELETE FROM account_notes WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/account-notes/:id — body: { text }
router.patch('/account-notes/:id', (req, res) => {
  try {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'Note text is required' });
    db.prepare(`UPDATE account_notes SET text = ? WHERE id = ?`).run(text, req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// DELETE /api/ledger/accounts/:id — removes the account and clears its cell on the Sheet.
// Does not delete any related bets/deposits/withdrawals history — those stay in place,
// just no longer linked to a visible account row.
// DELETE /api/ledger/accounts/:id — a true hard delete, for correcting a mistaken entry
// (wrong ID/bookie/bank typed in). No Sheet involvement — Account Entry never wrote to a
// Sheet in the first place. This is deliberately different from marking an account
// Finished (which keeps the row for ID-uniqueness/counting) — a deleted row is gone, and
// its ID becomes reusable again since it was never really "used".
router.delete('/accounts/:id', async (req, res) => {
  try {
    const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(req.params.id);
    if (!account) return res.status(404).json({ ok: false, error: 'Account not found' });

    const depositCount = db.prepare(`SELECT COUNT(*) c FROM deposits WHERE account_id = ?`).get(req.params.id).c;
    const withdrawalCount = db.prepare(`SELECT COUNT(*) c FROM withdrawals WHERE account_id = ?`).get(req.params.id).c;
    const betLegCount = db.prepare(`SELECT COUNT(*) c FROM bet_legs WHERE account_id = ?`).get(req.params.id).c;

    if (depositCount || withdrawalCount || betLegCount) {
      const parts = [];
      if (depositCount) parts.push(`${depositCount} deposit${depositCount>1?'s':''}`);
      if (withdrawalCount) parts.push(`${withdrawalCount} withdrawal${withdrawalCount>1?'s':''}`);
      if (betLegCount) parts.push(`${betLegCount} bet${betLegCount>1?'s':''}`);
      return res.status(409).json({
        ok: false,
        error: `Can't delete — this account has ${parts.join(', ')} attached, so it wasn't really "entered in error". Reverse the deposit/withdrawal(s) first if you genuinely want it gone, or use "Mark as Finished" instead if the activity is real.`
      });
    }

    db.prepare(`DELETE FROM account_notes WHERE account_id = ?`).run(req.params.id);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ================== DEPOSITS / WITHDRAWALS ==================

// POST /api/ledger/accounts/:id/deposit — body: { amount }
router.post('/accounts/:id/deposit', (req, res) => {
  const applyDeposit = db.transaction((accountId, amount) => {
    const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
    if (!account) throw new Error('Account not found');
    const newBalance = account.balance + amount;
    db.prepare(`UPDATE accounts SET balance = ?, updated_at = datetime('now') WHERE id = ?`).run(newBalance, accountId);
    if (account.profile) db.prepare(`UPDATE banks SET starting_balance = starting_balance - ? WHERE name = ?`).run(amount, account.profile);
    const info = db.prepare(`INSERT INTO deposits (account_id, amount, balance_after) VALUES (?, ?, ?)`).run(accountId, amount, newBalance);
    return { newBalance, id: info.lastInsertRowid };
  });
  try {
    const amount = parseFloat(req.body.amount);
    if (!(amount > 0)) return res.status(400).json({ ok: false, error: 'amount must be a positive number' });
    const { newBalance, id } = applyDeposit(req.params.id, amount);
    res.json({ ok: true, balance: newBalance, id });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/accounts/:id/withdraw — creates a pending withdrawal. The account's live
// balance is deducted immediately (the money is no longer available to bet with), but the
// bank isn't credited until the withdrawal is confirmed as actually landed.
router.post('/accounts/:id/withdraw', (req, res) => {
  const createPending = db.transaction((accountId, amount) => {
    const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
    if (!account) throw new Error('Account not found');
    // No floor at £0 — the site's shown balance can legitimately be stale (e.g. an unsettled
    // winning bet the account's real balance already reflects but the site doesn't yet), so a
    // withdrawal larger than the shown balance is allowed to go negative here rather than being
    // silently capped at 0. It self-corrects once the bet is settled and the balance updates.
    const newBalance = account.balance - amount;
    db.prepare(`UPDATE accounts SET balance = ?, updated_at = datetime('now') WHERE id = ?`).run(newBalance, accountId);
    const info = db.prepare(`INSERT INTO withdrawals (account_id, amount, balance_after, status) VALUES (?, ?, ?, 'pending')`).run(accountId, amount, newBalance);
    return { newBalance, id: info.lastInsertRowid };
  });
  try {
    const amount = parseFloat(req.body.amount);
    if (!(amount > 0)) return res.status(400).json({ ok: false, error: 'amount must be a positive number' });
    const { newBalance, id } = createPending(req.params.id, amount);
    res.json({ ok: true, balance: newBalance, id });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/withdrawals/:id/confirm — marks a withdrawal as verified in the bank.
// The account side already happened at request time — this only credits the bank.
router.patch('/withdrawals/:id/confirm', requireAdmin, (req, res) => {
  const doConfirm = db.transaction((id) => {
    const w = db.prepare(`SELECT wd.*, a.profile FROM withdrawals wd JOIN accounts a ON a.id = wd.account_id WHERE wd.id = ?`).get(id);
    if (!w) throw new Error('Withdrawal not found');
    if (w.status === 'confirmed') return; // already confirmed — don't double-apply
    if (w.profile) db.prepare(`UPDATE banks SET starting_balance = starting_balance + ? WHERE name = ?`).run(w.amount, w.profile);
    db.prepare(`UPDATE withdrawals SET status = 'confirmed' WHERE id = ?`).run(id);
  });
  try {
    doConfirm(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// DELETE /api/ledger/withdrawals/:id — removes the record.
router.delete('/withdrawals/:id', async (req, res) => {
  try {
    const w = db.prepare(`SELECT * FROM withdrawals WHERE id = ?`).get(req.params.id);
    if (!w) return res.status(404).json({ ok: false, error: 'Withdrawal not found' });
    db.prepare(`DELETE FROM withdrawals WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/withdrawals/:id/reverse — for one added in error. The account was
// deducted at request time regardless of status, so that's always undone here. The bank
// side is only undone if it was confirmed, since that's the only point it was ever credited.
// Soft-deletes (status -> 'reversed') rather than removing the row entirely, so there's a
// genuine record of it for the account's transaction history.
router.post('/withdrawals/:id/reverse', async (req, res) => {
  const doReverse = db.transaction((id) => {
    const w = db.prepare(`SELECT w.*, a.profile FROM withdrawals w JOIN accounts a ON a.id = w.account_id WHERE w.id = ?`).get(id);
    if (!w) throw new Error('Withdrawal not found');
    if (w.status === 'reversed') throw new Error('Already reversed');
    db.prepare(`UPDATE accounts SET balance = balance + ?, updated_at = datetime('now') WHERE id = ?`).run(w.amount, w.account_id);
    if (w.status === 'confirmed' && w.profile) {
      db.prepare(`UPDATE banks SET starting_balance = starting_balance - ? WHERE name = ?`).run(w.amount, w.profile);
    }
    db.prepare(`UPDATE withdrawals SET status = 'reversed', reversed_at = datetime('now') WHERE id = ?`).run(id);
    return w;
  });
  try {
    doReverse(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/withdrawals/:id/confiscate — the bookie refused to pay out a pending
// withdrawal. Moves the amount into Locked Funds (for record-keeping) and removes the
// withdrawal from Pending. The account was already deducted at request time, so for a
// pending withdrawal nothing further happens to it — it stays deducted, matching the money
// genuinely being gone. The bank is untouched, since the money never reached it.
router.post('/withdrawals/:id/confiscate', async (req, res) => {
  const doConfiscate = db.transaction((id) => {
    const w = db.prepare(`SELECT w.*, a.account_id AS account_code, a.bookie AS acct_bookie, a.profile AS bank FROM withdrawals w JOIN accounts a ON a.id = w.account_id WHERE w.id = ?`).get(id);
    if (!w) throw new Error('Withdrawal not found');
    // If it had somehow already been confirmed, the account was already deducted and the
    // bank already credited at that point — confiscating from there means the bookie
    // clawed back a completed transfer, which needs the bank credit undone.
    if (w.status === 'confirmed' && w.bank) {
      db.prepare(`UPDATE banks SET starting_balance = starting_balance - ? WHERE name = ?`).run(w.amount, w.bank);
    }
    db.prepare(`INSERT INTO locked_funds (account_code, bookie, bank, amount, source, linked_account_id) VALUES (?, ?, ?, ?, 'confiscated_withdrawal', ?)`)
      .run(w.account_code, w.acct_bookie, w.bank, w.amount, w.account_id);
    db.prepare(`DELETE FROM withdrawals WHERE id = ?`).run(id);
    return w;
  });
  try {
    doConfiscate(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

router.get('/deposits', (req, res) => {
  try {
    const { account_id } = req.query;
    let query = `SELECT d.*, a.profile, a.bookie, a.account_id AS account_code FROM deposits d JOIN accounts a ON a.id = d.account_id`;
    const params = [];
    if (account_id) { query += ` WHERE d.account_id = ?`; params.push(account_id); }
    query += ` ORDER BY d.created_at DESC LIMIT 500`;
    const rows = db.prepare(query).all(...params);
    res.json({ ok: true, deposits: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/deposits/:id — corrects the amount. Adjusts both the account balance
// and its linked bank balance by the difference (a deposit decreases the bank pool, so the
// bank-side adjustment moves opposite to the account-side one).
router.patch('/deposits/:id', (req, res) => {
  const doEdit = db.transaction((id, newAmount) => {
    const dep = db.prepare(`SELECT dep.*, a.profile FROM deposits dep JOIN accounts a ON a.id = dep.account_id WHERE dep.id = ?`).get(id);
    if (!dep) throw new Error('Deposit not found');
    const diff = newAmount - dep.amount;
    db.prepare(`UPDATE accounts SET balance = balance + ?, updated_at = datetime('now') WHERE id = ?`).run(diff, dep.account_id);
    if (dep.profile) db.prepare(`UPDATE banks SET starting_balance = starting_balance - ? WHERE name = ?`).run(diff, dep.profile);
    db.prepare(`UPDATE deposits SET amount = ?, balance_after = balance_after + ? WHERE id = ?`).run(newAmount, diff, id);
  });
  try {
    const newAmount = parseFloat(req.body.amount);
    if (!(newAmount > 0)) return res.status(400).json({ ok: false, error: 'amount must be a positive number' });
    doEdit(req.params.id, newAmount);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// DELETE /api/ledger/deposits/:id — removes the record.
router.delete('/deposits/:id', async (req, res) => {
  try {
    const d = db.prepare(`SELECT * FROM deposits WHERE id = ?`).get(req.params.id);
    if (!d) return res.status(404).json({ ok: false, error: 'Deposit not found' });
    db.prepare(`DELETE FROM deposits WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/deposits/:id/reverse — for one added in error. Subtracts the amount back
// out of the account's balance, then removes the record.
router.post('/deposits/:id/reverse', async (req, res) => {
  const doReverse = db.transaction((id) => {
    const d = db.prepare(`SELECT dep.*, a.profile FROM deposits dep JOIN accounts a ON a.id = dep.account_id WHERE dep.id = ?`).get(id);
    if (!d) throw new Error('Deposit not found');
    db.prepare(`UPDATE accounts SET balance = balance - ?, updated_at = datetime('now') WHERE id = ?`).run(d.amount, d.account_id);
    if (d.profile) db.prepare(`UPDATE banks SET starting_balance = starting_balance + ? WHERE name = ?`).run(d.amount, d.profile);
    db.prepare(`DELETE FROM deposits WHERE id = ?`).run(id);
    return d;
  });
  try {
    doReverse(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// GET /api/ledger/withdrawals?status=pending|confirmed
router.get('/withdrawals', (req, res) => {
  try {
    const { status, account_id } = req.query;
    let query = `SELECT w.*, a.profile, a.bookie, a.account_id AS account_code FROM withdrawals w JOIN accounts a ON a.id = w.account_id`;
    const clauses = [];
    const params = [];
    if (status) { clauses.push(`w.status = ?`); params.push(status); }
    if (account_id) { clauses.push(`w.account_id = ?`); params.push(account_id); }
    if (clauses.length) query += ` WHERE ` + clauses.join(' AND ');
    query += ` ORDER BY w.created_at DESC LIMIT 500`;
    const rows = db.prepare(query).all(...params);
    res.json({ ok: true, withdrawals: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/withdrawals/:id — corrects the amount. If still pending, no balance has
// moved yet so this just updates the stored amount. If confirmed, adjusts both the account
// and its linked bank balance by the difference.
router.patch('/withdrawals/:id', (req, res) => {
  const doEdit = db.transaction((id, newAmount) => {
    const w = db.prepare(`SELECT wd.*, a.profile FROM withdrawals wd JOIN accounts a ON a.id = wd.account_id WHERE wd.id = ?`).get(id);
    if (!w) throw new Error('Withdrawal not found');
    if (w.status === 'confirmed') {
      const diff = newAmount - w.amount;
      db.prepare(`UPDATE accounts SET balance = balance - ?, updated_at = datetime('now') WHERE id = ?`).run(diff, w.account_id);
      if (w.profile) db.prepare(`UPDATE banks SET starting_balance = starting_balance + ? WHERE name = ?`).run(diff, w.profile);
      db.prepare(`UPDATE withdrawals SET amount = ?, balance_after = balance_after - ? WHERE id = ?`).run(newAmount, diff, id);
    } else {
      db.prepare(`UPDATE withdrawals SET amount = ? WHERE id = ?`).run(newAmount, id);
    }
  });
  try {
    const newAmount = parseFloat(req.body.amount);
    if (!(newAmount > 0)) return res.status(400).json({ ok: false, error: 'amount must be a positive number' });
    doEdit(req.params.id, newAmount);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// ================== BETS ==================

// POST /api/ledger/bets
// body: { bet_type, date?, fields: {...}, legs: [{ account_id, stake }, ...] }
router.post('/bets', (req, res) => {
  const placeBet = db.transaction((bet_type, date, fields, legs, autoSettlePl) => {
    const total_stake = legs.reduce((s, l) => s + l.stake, 0);
    const isAutoSettle = typeof autoSettlePl === 'number';
    const result = isAutoSettle ? (autoSettlePl > 0 ? 'won' : autoSettlePl < 0 ? 'lost' : 'void') : 'open';
    const info = db.prepare(
      `INSERT INTO bets (bet_type, date, fields, total_stake, result, pl, settled_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(bet_type, date, JSON.stringify(fields), total_stake, result, isAutoSettle ? autoSettlePl : 0, isAutoSettle ? new Date().toISOString() : null);
    const betId = info.lastInsertRowid;
    const freeBet = hasNoRealStake(bet_type, fields);

    for (const leg of legs) {
      const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(leg.account_id);
      if (!account) throw new Error(`Account ${leg.account_id} not found`);
      if (isAutoSettle) {
        const share = total_stake > 0 ? leg.stake / total_stake : (legs.length ? 1 / legs.length : 0);
        const legPl = +(autoSettlePl * share).toFixed(2);
        db.prepare(`INSERT INTO bet_legs (bet_id, account_id, stake, settled, leg_pl) VALUES (?, ?, ?, 1, ?)`).run(betId, leg.account_id, leg.stake, legPl);
        db.prepare(`UPDATE accounts SET balance = balance + ?, updated_at = datetime('now') WHERE id = ?`).run(legPl, leg.account_id);
      } else {
        db.prepare(`INSERT INTO bet_legs (bet_id, account_id, stake) VALUES (?, ?, ?)`).run(betId, leg.account_id, leg.stake);
        if (!freeBet) {
          db.prepare(`UPDATE accounts SET balance = balance - ?, updated_at = datetime('now') WHERE id = ?`).run(leg.stake, leg.account_id);
        }
      }
    }
    return betId;
  });

  try {
    const { bet_type, date, fields, legs, autoSettlePl } = req.body;
    if (!bet_type) return res.status(400).json({ ok: false, error: 'bet_type required' });
    if (req.userRole === 'staff' && getBetTypeGroup(bet_type) === 'buzzer') {
      return res.status(403).json({ ok: false, error: 'Staff can only log bets under Assistant sheets.' });
    }
    if (!Array.isArray(legs) || legs.length === 0) return res.status(400).json({ ok: false, error: 'at least one leg (account + stake) required' });
    for (const l of legs) {
      if (!l.account_id || !(parseFloat(l.stake) > 0)) return res.status(400).json({ ok: false, error: 'each leg needs a valid account_id and positive stake' });
    }
    const betId = placeBet(bet_type, date || new Date().toISOString(), fields || {}, legs.map(l => ({ account_id: l.account_id, stake: parseFloat(l.stake) })), typeof autoSettlePl === 'number' ? autoSettlePl : undefined);
    const bet = db.prepare(`SELECT * FROM bets WHERE id = ?`).get(betId);
    const betLegs = db.prepare(`SELECT * FROM bet_legs WHERE bet_id = ?`).all(betId);
    res.json({ ok: true, bet: { ...bet, fields: JSON.parse(bet.fields), legs: betLegs } });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/bets/backlay — dedicated creation route for the "Back & Lay" bet type.
// Unlike every other bet type, this has two independent groups of legs (backing accounts at
// the bookie, laying accounts at the exchange), each with its OWN odds — and lay legs also
// carry their own commission rate. total_stake is the sum of back stakes only (the real
// money staked at the bookie); a back leg deducts its stake as normal, but a lay leg deducts
// its *liability* (stake × (odds-1)) — the amount actually locked up at the exchange.
router.post('/bets/backlay', (req, res) => {
  const placeBackLay = db.transaction((date, fields, backLegs, layLegs) => {
    const totalBackStake = +backLegs.reduce((s, l) => s + l.stake, 0).toFixed(2);
    const info = db.prepare(
      `INSERT INTO bets (bet_type, date, fields, total_stake, result, pl, settled_at) VALUES ('Back & Lay', ?, ?, ?, 'open', 0, NULL)`
    ).run(date, JSON.stringify(fields), totalBackStake);
    const betId = info.lastInsertRowid;

    for (const leg of backLegs) {
      const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(leg.account_id);
      if (!account) throw new Error(`Account ${leg.account_id} not found`);
      db.prepare(`INSERT INTO bet_legs (bet_id, account_id, stake, role, odds) VALUES (?, ?, ?, 'back', ?)`)
        .run(betId, leg.account_id, leg.stake, leg.odds);
      db.prepare(`UPDATE accounts SET balance = balance - ?, updated_at = datetime('now') WHERE id = ?`).run(leg.stake, leg.account_id);
    }
    for (const leg of layLegs) {
      const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(leg.account_id);
      if (!account) throw new Error(`Account ${leg.account_id} not found`);
      const liability = +(leg.stake * (leg.odds - 1)).toFixed(2);
      db.prepare(`INSERT INTO bet_legs (bet_id, account_id, stake, role, odds, commission) VALUES (?, ?, ?, 'lay', ?, ?)`)
        .run(betId, leg.account_id, leg.stake, leg.odds, leg.commission);
      db.prepare(`UPDATE accounts SET balance = balance - ?, updated_at = datetime('now') WHERE id = ?`).run(liability, leg.account_id);
    }
    return betId;
  });

  try {
    const { date, fields, backLegs, layLegs } = req.body;
    if (req.userRole === 'staff') return res.status(403).json({ ok: false, error: 'Staff can only log bets under Assistant sheets.' });
    if (!Array.isArray(backLegs) || backLegs.length === 0) return res.status(400).json({ ok: false, error: 'at least one back (bookie) leg required' });
    if (!Array.isArray(layLegs) || layLegs.length === 0) return res.status(400).json({ ok: false, error: 'at least one lay (exchange) leg required' });
    for (const l of backLegs) {
      if (!l.account_id || !(parseFloat(l.stake) > 0) || !(parseFloat(l.odds) > 1)) return res.status(400).json({ ok: false, error: 'each back leg needs an account, a positive stake, and odds greater than 1' });
    }
    for (const l of layLegs) {
      if (!l.account_id || !(parseFloat(l.stake) > 0) || !(parseFloat(l.odds) > 1)) return res.status(400).json({ ok: false, error: 'each lay leg needs an account, a positive stake, and odds greater than 1' });
      const c = parseFloat(l.commission);
      if (isNaN(c) || c < 0 || c >= 1) return res.status(400).json({ ok: false, error: 'each lay leg needs a commission rate between 0 and 100%' });
    }
    const betId = placeBackLay(
      date || new Date().toISOString(),
      fields || {},
      backLegs.map(l => ({ account_id: l.account_id, stake: +parseFloat(l.stake).toFixed(2), odds: parseFloat(l.odds) })),
      layLegs.map(l => ({ account_id: l.account_id, stake: +parseFloat(l.stake).toFixed(2), odds: parseFloat(l.odds), commission: parseFloat(l.commission) }))
    );
    const bet = db.prepare(`SELECT * FROM bets WHERE id = ?`).get(betId);
    const betLegs = db.prepare(`SELECT * FROM bet_legs WHERE bet_id = ?`).all(betId);
    res.json({ ok: true, bet: { ...bet, fields: JSON.parse(bet.fields), legs: betLegs } });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/bets/:id/settle-backlay — body: { result, doublePayout, customWinAmount, fundsType }
// result is one of: 'back_won' (the backed selection won — back legs profit, lay legs pay
// out their liability), 'lay_won' (the selection lost — back legs lose their stake, lay legs
// win their stake minus commission), 'void' (both sides void — treated as one shared result
// for now, see back-lay-bet-input-spec), or 'open' (revert to unsettled).
//
// Each leg's P/L is computed directly from its own stored stake/odds/commission — no
// proportional blending needed, unlike the generic settle route, because (unlike every other
// bet type) each leg here really does have its own odds.
//
// doublePayout overrides the BOOKIE side only: the exchange side always settles on the real
// result regardless. When true, customWinAmount replaces the normal back-side P/L (split
// proportionally across back legs by stake share) — fundsType 'free' means no stake is
// deducted from that figure (nothing real was ever staked to get it back), 'normal' means
// customWinAmount is the real total return so the stake comes off it as usual.
router.patch('/bets/:id/settle-backlay', (req, res) => {
  const settle = db.transaction((betId, result, doublePayout, customWinAmount, fundsType) => {
    const bet = db.prepare(`SELECT * FROM bets WHERE id = ?`).get(betId);
    if (!bet) throw new Error('Bet not found');
    if (bet.bet_type !== 'Back & Lay') throw new Error('Not a Back & Lay bet');
    const legs = db.prepare(`SELECT * FROM bet_legs WHERE bet_id = ?`).all(betId);
    const backLegs = legs.filter(l => l.role === 'back');
    const layLegs = legs.filter(l => l.role === 'lay');
    const totalBackStake = backLegs.reduce((s, l) => s + l.stake, 0);

    // Reverse whatever this bet is currently applying to account balances, so re-settling
    // (or an override) never double-counts — same reasoning as the generic /settle route.
    if (bet.result !== 'open') {
      for (const leg of legs) {
        db.prepare(`UPDATE accounts SET balance = balance - ? - ?, updated_at = datetime('now') WHERE id = ?`)
          .run(legCommitted(leg), leg.leg_pl || 0, leg.account_id);
      }
    }

    const fields = JSON.parse(bet.fields);

    if (result === 'open') {
      for (const leg of legs) {
        db.prepare(`UPDATE bet_legs SET settled = 0, leg_pl = 0 WHERE id = ?`).run(leg.id);
        db.prepare(`UPDATE accounts SET balance = balance + ?, updated_at = datetime('now') WHERE id = ?`)
          .run(legCommitted(leg), leg.account_id);
      }
      delete fields['Outcome']; delete fields['Double Payout']; delete fields['Double Payout Amount']; delete fields['Double Payout Funds'];
      db.prepare(`UPDATE bets SET result = 'open', pl = 0, fields = ?, settled_at = NULL WHERE id = ?`).run(JSON.stringify(fields), betId);
      return { pl: 0, breakdown: null };
    }

    const legPlMap = {};
    if (result === 'void') {
      legs.forEach(l => { legPlMap[l.id] = 0; });
    } else {
      layLegs.forEach(l => {
        legPlMap[l.id] = result === 'back_won'
          ? -(l.stake * (l.odds - 1))            // lay loses — liability forfeited
          : (l.stake * (1 - (l.commission || 0))); // lay wins — stake minus commission
      });
      if (doublePayout) {
        const totalBackPl = customWinAmount - (fundsType === 'free' ? 0 : totalBackStake);
        backLegs.forEach(l => {
          const share = totalBackStake > 0 ? l.stake / totalBackStake : (backLegs.length ? 1 / backLegs.length : 0);
          legPlMap[l.id] = totalBackPl * share;
        });
      } else {
        backLegs.forEach(l => {
          legPlMap[l.id] = result === 'back_won' ? (l.stake * (l.odds - 1)) : -l.stake;
        });
      }
    }

    let bookiePl = 0, exchangePl = 0;
    for (const leg of legs) {
      const legPl = +(legPlMap[leg.id] || 0).toFixed(2);
      db.prepare(`UPDATE bet_legs SET settled = 1, leg_pl = ? WHERE id = ?`).run(legPl, leg.id);
      db.prepare(`UPDATE accounts SET balance = balance + ? + ?, updated_at = datetime('now') WHERE id = ?`)
        .run(legCommitted(leg), legPl, leg.account_id);
      if (leg.role === 'back') bookiePl += legPl; else exchangePl += legPl;
    }
    const totalPl = +(bookiePl + exchangePl).toFixed(2);

    fields['Outcome'] = result === 'back_won' ? 'Back Bet Won' : result === 'lay_won' ? 'Lay Bet Won' : 'Void';
    if (result !== 'void' && doublePayout) {
      fields['Double Payout'] = 'Yes';
      fields['Double Payout Amount'] = customWinAmount;
      fields['Double Payout Funds'] = fundsType === 'free' ? 'Free Bet' : 'Normal Funds';
    } else {
      fields['Double Payout'] = 'No';
      delete fields['Double Payout Amount']; delete fields['Double Payout Funds'];
    }

    const storedResult = result === 'back_won' ? 'won' : result === 'lay_won' ? 'lost' : 'void';
    db.prepare(`UPDATE bets SET result = ?, pl = ?, fields = ?, settled_at = datetime('now') WHERE id = ?`)
      .run(storedResult, totalPl, JSON.stringify(fields), betId);

    return { pl: totalPl, breakdown: { bookie: +bookiePl.toFixed(2), exchange: +exchangePl.toFixed(2) } };
  });

  try {
    const { result, doublePayout, customWinAmount, fundsType } = req.body;
    if (!['back_won', 'lay_won', 'void', 'open'].includes(result)) return res.status(400).json({ ok: false, error: 'result must be back_won, lay_won, void, or open' });
    if (doublePayout && !(typeof customWinAmount === 'number')) return res.status(400).json({ ok: false, error: 'customWinAmount required when doublePayout is true' });
    const out = settle(req.params.id, result, !!doublePayout, doublePayout ? customWinAmount : 0, fundsType === 'free' ? 'free' : 'normal');
    const bet = db.prepare(`SELECT * FROM bets WHERE id = ?`).get(req.params.id);
    res.json({ ok: true, pl: out.pl, breakdown: out.breakdown, bet: { ...bet, fields: JSON.parse(bet.fields) } });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// GET /api/ledger/bets?status=open&type=Value
router.get('/bets', (req, res) => {
  try {
    const { status, type, limit, offset, dateRange } = req.query;
    if (req.userRole === 'staff' && type && getBetTypeGroup(type) === 'buzzer') {
      return res.status(403).json({ ok: false, error: 'Staff can only view Assistant sheets.' });
    }
    const filters = [];
    const params = [];
    if (status) { filters.push('result = ?'); params.push(status); }
    if (type) { filters.push('bet_type = ?'); params.push(type); }
    if (dateRange === 'today') { filters.push(`date(date) = date('now')`); }
    else if (dateRange === 'month') { filters.push(`strftime('%Y-%m', date) = strftime('%Y-%m', 'now')`); }
    // Dashboard-only exception: Staff can see (and settle) Admin's open Buzzer bets from
    // there specifically, via an explicit flag — deliberately narrow, only ever applies to
    // open bets on this one call. Everywhere else (settled/historical Buzzer data, any
    // other view) Staff's access is unchanged.
    const dashboardOpenException = status === 'open' && req.query.dashboardOpen === '1';
    if (req.userRole === 'staff' && !type && !dashboardOpenException) {
      const buzzerTypes = [...HARDCODED_BUZZER_TYPES, ...db.prepare(`SELECT key FROM custom_sheets WHERE user_group = 'buzzer'`).all().map(r => r.key)];
      if (buzzerTypes.length) { filters.push(`bet_type NOT IN (${buzzerTypes.map(()=>'?').join(',')})`); params.push(...buzzerTypes); }
    }
    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    // Fast aggregate summary (count, wins/losses/open, total stake/P/L) computed entirely
    // in SQL — never requires loading the full dataset into memory or over the network.
    const summary = db.prepare(
      `SELECT COUNT(*) count,
              COALESCE(SUM(CASE WHEN result='open' THEN 1 ELSE 0 END),0) open,
              COALESCE(SUM(CASE WHEN result='won' THEN 1 ELSE 0 END),0) wins,
              COALESCE(SUM(CASE WHEN result='lost' THEN 1 ELSE 0 END),0) losses,
              COALESCE(SUM(total_stake),0) totalStake,
              COALESCE(SUM(pl),0) totalPl,
              COALESCE(SUM(CAST(json_extract(fields, '$.EV') AS REAL)),0) totalEV
       FROM bets ${whereClause}`
    ).get(...params);

    const lim = Math.min(parseInt(limit) || 200, 5000);
    const off = Math.max(parseInt(offset) || 0, 0);
    const rawBets = db.prepare(
      `SELECT * FROM bets ${whereClause} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`
    ).all(...params, lim, off);

    // One batched query for leg counts across just this page, instead of a separate
    // query per row — that N+1 pattern was slow/failing outright on large tabs.
    const legCounts = {};
    if (rawBets.length) {
      const ids = rawBets.map(b => b.id);
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`SELECT bet_id, COUNT(*) c FROM bet_legs WHERE bet_id IN (${placeholders}) GROUP BY bet_id`)
        .all(...ids).forEach(r => { legCounts[r.bet_id] = r.c; });
    }

    // Linked account's ID code (D001/C001-style), for the Account ID display column — only
    // meaningful once a bet's been settled or linked to a real account via Link Account.
    const accountCodes = {};
    if (rawBets.length) {
      const ids = rawBets.map(b => b.id);
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(
        `SELECT bl.bet_id, a.account_id FROM bet_legs bl JOIN accounts a ON a.id = bl.account_id WHERE bl.bet_id IN (${placeholders})`
      ).all(...ids).forEach(r => { accountCodes[r.bet_id] = r.account_id; });
    }

    // Back & Lay has two independent groups of accounts (bookie legs, exchange legs), so the
    // single account_code/leg_count above can't represent it — build per-role code+count
    // groups instead, keyed the same "first code + N" way, for its own Bookie ID/Exchange ID
    // columns. Unused (and harmless) for every other bet type, since role is always NULL there.
    const backCodes = {}, backCounts = {}, layCodes = {}, layCounts = {};
    if (rawBets.length && type === 'Back & Lay') {
      const ids = rawBets.map(b => b.id);
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(
        `SELECT bl.bet_id, bl.role, a.account_id FROM bet_legs bl JOIN accounts a ON a.id = bl.account_id WHERE bl.bet_id IN (${placeholders}) ORDER BY bl.id`
      ).all(...ids).forEach(r => {
        const codes = r.role === 'lay' ? layCodes : backCodes;
        const counts = r.role === 'lay' ? layCounts : backCounts;
        if (!(r.bet_id in codes)) codes[r.bet_id] = r.account_id;
        counts[r.bet_id] = (counts[r.bet_id] || 0) + 1;
      });
    }

    const bets = rawBets.map(b => ({
      ...b, fields: JSON.parse(b.fields), leg_count: legCounts[b.id] || 0, account_code: accountCodes[b.id] || null,
      back_account_code: backCodes[b.id] || null, back_leg_count: backCounts[b.id] || 0,
      exchange_account_code: layCodes[b.id] || null, exchange_leg_count: layCounts[b.id] || 0,
    }));

    const noteRows = rawBets.length ? db.prepare(`SELECT bet_id FROM bet_notes WHERE bet_id IN (${rawBets.map(()=>'?').join(',')})`).all(...rawBets.map(b=>b.id)) : [];
    const notedIds = new Set(noteRows.map(r => r.bet_id));
    bets.forEach(b => { b.has_note = notedIds.has(b.id); });

    res.json({ ok: true, bets, summary, limit: lim, offset: off });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// GET /api/ledger/bets/:id/legs — every account actually used on this bet, with each leg's
// own stake/settlement status, for the "C054 + 4"-style expandable display. NOTE: odds are
// NOT stored per leg — a bet has exactly one Odds value (bets.fields.Odds), shared across
// every account on it — so this returns that single bet-level odds value once, alongside
// each leg, rather than a nonexistent per-account figure.
router.get('/bets/:id/legs', (req, res) => {
  try {
    const bet = db.prepare(`SELECT * FROM bets WHERE id = ?`).get(req.params.id);
    if (!bet) return res.status(404).json({ ok: false, error: 'Bet not found' });
    const legs = db.prepare(
      `SELECT bl.id, bl.account_id, bl.stake, bl.leg_pl, bl.settled, bl.role, bl.odds AS leg_odds, bl.commission,
              a.account_id AS account_code, a.profile, a.bookie
       FROM bet_legs bl JOIN accounts a ON a.id = bl.account_id
       WHERE bl.bet_id = ? ORDER BY bl.id`
    ).all(req.params.id);
    const fields = JSON.parse(bet.fields);
    res.json({ ok: true, legs, odds: typeof fields.Odds === 'number' ? fields.Odds : null, bet_type: bet.bet_type, result: bet.result });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/bets/:id/legs — attaches an account+stake to an already-existing bet
// (used for historical open bets migrated without one, linked in case-by-case afterward).
// Deducts the stake from the account's balance, same as placing a bet normally does.
router.post('/bets/:id/legs', (req, res) => {
  const doLink = db.transaction((betId, accountId, stake) => {
    const bet = db.prepare(`SELECT * FROM bets WHERE id = ?`).get(betId);
    if (!bet) throw new Error('Bet not found');
    const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
    if (!account) throw new Error('Account not found');
    db.prepare(`INSERT INTO bet_legs (bet_id, account_id, stake) VALUES (?, ?, ?)`).run(betId, accountId, stake);
    db.prepare(`UPDATE accounts SET balance = balance - ?, updated_at = datetime('now') WHERE id = ?`).run(stake, accountId);
  });
  try {
    const { account_id, stake } = req.body;
    const stakeAmt = parseFloat(stake);
    if (!account_id) return res.status(400).json({ ok: false, error: 'account_id required' });
    if (!(stakeAmt > 0)) return res.status(400).json({ ok: false, error: 'stake must be a positive number' });
    doLink(req.params.id, account_id, stakeAmt);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// Bet types this "Add Account" merge feature supports — a stake-weighted blended Odds/Place
// Odds figure only makes sense for types with that single-Odds shape. Casino (balance-based,
// no odds), each-way BB Horse/Golf/RTP (two odds columns with their own blending question),
// Ninja Golf BFEX, and Freeze (singleLegOnly) are deliberately excluded. Back & Lay has its
// own separate endpoint below, since it never blends odds at all.
const ADD_ACCOUNT_TYPES = [
  'Value', 'Keithbot', 'American Props', 'Corners', 'Discord', 'Offers (Personal)',
  'Offers (VA)', 'Other Bets', 'Dogs + Horses', 'Dogs + Horses (VA)', 'BB - BT',
];

// POST /api/ledger/bets/:id/add-account — folds a second (third, ...) bookmaker/account leg
// into an already-placed bet: combined stake, a stake-weighted "neutral" odds. This blend is
// exact, not approximate — the app's settle route only ever needs one overall Odds figure and
// a stake-share split (never each leg's individual odds — confirmed against PATCH
// /bets/:id/settle), so combinedStake × neutralOdds on a win reproduces the true sum
// stake1×odds1 + stake2×odds2. Bookie identity is read from the ACCOUNT, not from `fields` —
// bookieFieldKey (and whether a bookie field exists at all — BB - BT has none) varies by bet
// type, but every account always has a real `bookie`.
router.post('/bets/:id/add-account', (req, res) => {
  const addAccount = db.transaction((betId, accountId, stake, odds, placeOdds, bookieFieldKey) => {
    const bet = db.prepare(`SELECT * FROM bets WHERE id = ?`).get(betId);
    if (!bet) throw new Error('Bet not found');
    if (!ADD_ACCOUNT_TYPES.includes(bet.bet_type)) throw new Error(`Add Account isn't supported for ${bet.bet_type}.`);
    if (bet.result !== 'open') throw new Error('Only open bets can have an account added — settle/override happens once, on the combined row.');

    const newAccount = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
    if (!newAccount) throw new Error('Account not found');

    const legs = db.prepare(
      `SELECT bl.*, a.bookie AS account_bookie FROM bet_legs bl JOIN accounts a ON a.id = bl.account_id
       WHERE bl.bet_id = ? ORDER BY bl.id`
    ).all(betId);

    const parsed = JSON.parse(bet.fields);
    const freeBet = hasNoRealStake(bet.bet_type, parsed);
    if (!freeBet) {
      db.prepare(`UPDATE accounts SET balance = balance - ?, updated_at = datetime('now') WHERE id = ?`).run(stake, accountId);
    }

    // Which fields key holds the odds number — 'Odds' for almost everything, 'Back Odds' for
    // Other Bets (the one type without a plain 'Odds' field).
    const oddsKey = typeof parsed.Odds === 'number' ? 'Odds' : (typeof parsed['Back Odds'] === 'number' ? 'Back Odds' : 'Odds');
    const currentOdds = typeof parsed[oddsKey] === 'number' ? parsed[oddsKey] : odds;
    const existingStake = bet.total_stake || 0;

    // First time this bet gets a second account: lock each existing leg's real odds in
    // before the bet-level figure changes to a blend — pure record-keeping (settlement never
    // reads leg.odds for this bet shape), so the legs modal can still show what each account
    // actually got.
    if (legs.length && !legs.some(l => typeof l.odds === 'number')) {
      for (const leg of legs) {
        db.prepare(`UPDATE bet_legs SET odds = ? WHERE id = ?`).run(currentOdds, leg.id);
      }
    }

    db.prepare(`INSERT INTO bet_legs (bet_id, account_id, stake, odds) VALUES (?, ?, ?, ?)`).run(betId, accountId, stake, odds);

    const newTotalStake = +(existingStake + stake).toFixed(2);
    const blendedOdds = existingStake > 0
      ? +(((existingStake * currentOdds) + (stake * odds)) / newTotalStake).toFixed(2)
      : odds;
    parsed[oddsKey] = blendedOdds;

    if (parsed['Each-Way'] === true && typeof placeOdds === 'number' && typeof parsed['Place Odds'] === 'number') {
      parsed['Place Odds'] = +(((existingStake * parsed['Place Odds']) + (stake * placeOdds)) / newTotalStake).toFixed(2);
    }

    // Also update whichever field holds the displayed stake, matching the same dynamic
    // lookup the leg-delete endpoint uses (varies: 'Stake' vs 'Total Stake' by bet type).
    const stakeKey = Object.keys(parsed).find(k => k.toLowerCase().replace(/[^a-z]/g, '') === 'stake' || k.toLowerCase().replace(/[^a-z]/g, '') === 'totalstake');
    if (stakeKey) parsed[stakeKey] = newTotalStake;

    const firstLegBookie = legs.length ? legs[0].account_bookie : newAccount.bookie;
    if (newAccount.bookie !== firstLegBookie) {
      const newLegCount = legs.length + 1;
      parsed[bookieFieldKey] = `${firstLegBookie} + ${newLegCount - 1}`;
    }

    db.prepare(`UPDATE bets SET total_stake = ?, fields = ? WHERE id = ?`).run(newTotalStake, JSON.stringify(parsed), betId);
  });

  try {
    const { account_id, stake, odds, placeOdds, bookieFieldKey } = req.body;
    const stakeAmt = parseFloat(stake);
    const oddsAmt = parseFloat(odds);
    const placeOddsAmt = placeOdds != null && placeOdds !== '' ? parseFloat(placeOdds) : null;
    if (!account_id) return res.status(400).json({ ok: false, error: 'account_id required' });
    if (!(stakeAmt > 0)) return res.status(400).json({ ok: false, error: 'stake must be a positive number' });
    if (!(oddsAmt > 1)) return res.status(400).json({ ok: false, error: 'odds must be greater than 1' });
    addAccount(req.params.id, account_id, stakeAmt, oddsAmt, placeOddsAmt, bookieFieldKey || 'Bookie');
    const bet = db.prepare(`SELECT * FROM bets WHERE id = ?`).get(req.params.id);
    res.json({ ok: true, bet: { ...bet, fields: JSON.parse(bet.fields) } });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/bets/:id/add-account/backlay — Back & Lay's own leg-add endpoint. Unlike
// the generic one above, no blending happens at all — each leg already carries its own real
// odds (and lay legs their own commission), exactly mirroring how POST /bets/backlay creates
// the first set of legs. total_stake only grows for back legs (lay legs represent the
// hedge/liability, not additional staked money — matches creation-time behaviour). The row's
// "+N" account-code labels are already fully driven by bet_legs counts, not `fields`, so
// nothing there needs updating either.
router.post('/bets/:id/add-account/backlay', (req, res) => {
  const addLeg = db.transaction((betId, role, accountId, stake, odds, commission) => {
    const bet = db.prepare(`SELECT * FROM bets WHERE id = ?`).get(betId);
    if (!bet) throw new Error('Bet not found');
    if (bet.bet_type !== 'Back & Lay') throw new Error('This endpoint is only for Back & Lay bets.');
    if (bet.result !== 'open') throw new Error('Only open bets can have an account added — settle/override happens once, on the combined row.');

    const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
    if (!account) throw new Error('Account not found');

    if (role === 'back') {
      db.prepare(`INSERT INTO bet_legs (bet_id, account_id, stake, role, odds) VALUES (?, ?, ?, 'back', ?)`).run(betId, accountId, stake, odds);
      db.prepare(`UPDATE accounts SET balance = balance - ?, updated_at = datetime('now') WHERE id = ?`).run(stake, accountId);
      db.prepare(`UPDATE bets SET total_stake = total_stake + ? WHERE id = ?`).run(stake, betId);
    } else {
      const liability = +(stake * (odds - 1)).toFixed(2);
      db.prepare(`INSERT INTO bet_legs (bet_id, account_id, stake, role, odds, commission) VALUES (?, ?, ?, 'lay', ?, ?)`).run(betId, accountId, stake, odds, commission);
      db.prepare(`UPDATE accounts SET balance = balance - ?, updated_at = datetime('now') WHERE id = ?`).run(liability, accountId);
    }
  });

  try {
    const { role, account_id, stake, odds, commission } = req.body;
    if (!['back', 'lay'].includes(role)) return res.status(400).json({ ok: false, error: 'role must be back or lay' });
    if (!account_id) return res.status(400).json({ ok: false, error: 'account_id required' });
    const stakeAmt = parseFloat(stake);
    const oddsAmt = parseFloat(odds);
    if (!(stakeAmt > 0) || !(oddsAmt > 1)) return res.status(400).json({ ok: false, error: 'each leg needs a positive stake and odds greater than 1' });
    let commissionAmt = 0;
    if (role === 'lay') {
      commissionAmt = parseFloat(commission);
      if (isNaN(commissionAmt) || commissionAmt < 0 || commissionAmt >= 1) return res.status(400).json({ ok: false, error: 'lay leg needs a commission rate between 0 and 100%' });
    }
    addLeg(req.params.id, role, account_id, stakeAmt, oddsAmt, commissionAmt);
    const bet = db.prepare(`SELECT * FROM bets WHERE id = ?`).get(req.params.id);
    res.json({ ok: true, bet: { ...bet, fields: JSON.parse(bet.fields) } });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// DELETE /api/ledger/bets/:id/legs/:legId — removes one account from a multi-account bet
// (e.g. the wrong account was accidentally included when placing). Reverses exactly that
// leg's effect on its account's balance — the same open-vs-settled reversal math used by
// DELETE /bets/:id — then rescales the bet's total_stake/pl/EV down to match the remaining
// legs. Refuses to remove a bet's only leg — that's what "Delete bet" is for.
router.delete('/bets/:id/legs/:legId', (req, res) => {
  const removeLeg = db.transaction((betId, legId) => {
    const bet = db.prepare(`SELECT * FROM bets WHERE id = ?`).get(betId);
    if (!bet) throw new Error('Bet not found');
    const legs = db.prepare(`SELECT * FROM bet_legs WHERE bet_id = ?`).all(betId);
    const leg = legs.find(l => l.id == legId);
    if (!leg) throw new Error('Leg not found on this bet');
    if (legs.length <= 1) throw new Error('This is the only account on this bet — delete the whole bet instead.');

    const freeBet = hasNoRealStake(bet.bet_type, bet.fields);
    if (bet.result === 'open') {
      if (!freeBet) {
        db.prepare(`UPDATE accounts SET balance = balance + ?, updated_at = datetime('now') WHERE id = ?`)
          .run(legCommitted(leg), leg.account_id);
      }
    } else {
      // Net effect of creation-deduction + settlement-payout was just the P/L (same reasoning
      // as DELETE /bets/:id) — reversing this one leg only needs to undo its own leg_pl.
      db.prepare(`UPDATE accounts SET balance = balance - ?, updated_at = datetime('now') WHERE id = ?`)
        .run(leg.leg_pl || 0, leg.account_id);
    }

    db.prepare(`DELETE FROM bet_legs WHERE id = ?`).run(leg.id);

    const remainingLegs = legs.filter(l => l.id != legId);
    const oldStake = bet.total_stake;
    const newStake = +remainingLegs.reduce((s, l) => s + l.stake, 0).toFixed(2);
    const newPl = bet.result === 'open' ? 0 : +remainingLegs.reduce((s, l) => s + (l.leg_pl || 0), 0).toFixed(2);
    const ratio = oldStake > 0 ? newStake / oldStake : 1;

    const fields = JSON.parse(bet.fields);
    const stakeKey = Object.keys(fields).find(k => k.toLowerCase().replace(/[^a-z]/g,'') === 'stake' || k.toLowerCase().replace(/[^a-z]/g,'') === 'totalstake');
    if (stakeKey) fields[stakeKey] = newStake;
    const evKey = ('EV £' in fields) ? 'EV £' : ('EV' in fields ? 'EV' : null);
    if (evKey && typeof fields[evKey] === 'number') fields[evKey] = +(fields[evKey] * ratio).toFixed(2);

    db.prepare(`UPDATE bets SET total_stake = ?, pl = ?, fields = ? WHERE id = ?`).run(newStake, newPl, JSON.stringify(fields), betId);
  });

  try {
    removeLeg(req.params.id, req.params.legId);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/bets/:id/legs/:legId/reassign — body: { account_id }
// Corrects a leg logged against the wrong account (e.g. D086 was typed but D087 was actually
// used) — moves the leg to the new account, reversing whatever balance effect it currently
// has on the old account and applying the equivalent effect to the new one. Stake/P&L/EV on
// the bet itself are untouched — only which account they're attributed to changes. The new
// account must be on the same bookie (the actual bet was placed with that bookie) and not
// already have its own leg on this bet.
router.patch('/bets/:id/legs/:legId/reassign', (req, res) => {
  const reassign = db.transaction((betId, legId, newAccountId) => {
    const bet = db.prepare(`SELECT * FROM bets WHERE id = ?`).get(betId);
    if (!bet) throw new Error('Bet not found');
    const legs = db.prepare(`SELECT * FROM bet_legs WHERE bet_id = ?`).all(betId);
    const leg = legs.find(l => l.id == legId);
    if (!leg) throw new Error('Leg not found on this bet');

    const oldAccount = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(leg.account_id);
    const newAccount = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(newAccountId);
    if (!newAccount) throw new Error('New account not found');
    if (newAccount.id === oldAccount.id) throw new Error('That is already the account on this leg.');
    if (newAccount.bookie !== oldAccount.bookie) throw new Error(`New account must be on ${oldAccount.bookie} — same as the original.`);
    if (legs.some(l => l.id != legId && l.account_id === newAccount.id)) throw new Error('That account already has a leg on this bet.');

    const freeBet = hasNoRealStake(bet.bet_type, bet.fields);
    if (bet.result === 'open') {
      if (!freeBet) {
        db.prepare(`UPDATE accounts SET balance = balance + ?, updated_at = datetime('now') WHERE id = ?`).run(legCommitted(leg), oldAccount.id);
        db.prepare(`UPDATE accounts SET balance = balance - ?, updated_at = datetime('now') WHERE id = ?`).run(legCommitted(leg), newAccount.id);
      }
    } else {
      // Same net-effect-is-just-the-P/L reasoning as the delete path — reverse it off the old
      // account, apply the same figure to the new one.
      db.prepare(`UPDATE accounts SET balance = balance - ?, updated_at = datetime('now') WHERE id = ?`).run(leg.leg_pl || 0, oldAccount.id);
      db.prepare(`UPDATE accounts SET balance = balance + ?, updated_at = datetime('now') WHERE id = ?`).run(leg.leg_pl || 0, newAccount.id);
    }

    db.prepare(`UPDATE bet_legs SET account_id = ? WHERE id = ?`).run(newAccount.id, leg.id);
  });

  try {
    const newAccountId = req.body.account_id;
    if (!newAccountId) return res.status(400).json({ ok: false, error: 'account_id required' });
    reassign(req.params.id, req.params.legId, newAccountId);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/bets/:id/settle — body: { result: 'won'|'lost'|'void', pl: number }
// pl is the total net profit/loss for the whole bet (negative for a loss, matching your
// existing sheet convention where P/L already nets out the stake).
// PATCH /api/ledger/bets/:id/bettype — corrects Normal <-> Free Bet independently of
// settlement. Never touches result, pl, or account balance — safe to use on a still-open
// bet. Recalculates EV with the right formula if Odds/Fairs are present.
router.patch('/bets/:id/bettype', (req, res) => {
  try {
    const bet = db.prepare(`SELECT * FROM bets WHERE id = ?`).get(req.params.id);
    if (!bet) return res.status(404).json({ ok: false, error: 'Bet not found' });
    const { betType } = req.body;
    if (!['Normal', 'Free Bet'].includes(betType)) return res.status(400).json({ ok: false, error: 'betType must be Normal or Free Bet' });
    const fields = JSON.parse(bet.fields);
    fields['Bet Type'] = betType;
    if (typeof fields.Odds === 'number' && typeof fields.Fairs === 'number' && bet.total_stake > 0) {
      fields['EV'] = +(betType === 'Free Bet'
        ? bet.total_stake * (fields.Odds - 1) / fields.Fairs
        : bet.total_stake * (fields.Odds / fields.Fairs - 1)
      ).toFixed(2);
    }
    db.prepare(`UPDATE bets SET fields = ? WHERE id = ?`).run(JSON.stringify(fields), req.params.id);
    res.json({ ok: true, ev: fields['EV'] });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// GET /api/ledger/bets/:id/note
router.get('/bets/:id/note', (req, res) => {
  try {
    const row = db.prepare(`SELECT * FROM bet_notes WHERE bet_id = ?`).get(req.params.id);
    res.json({ ok: true, note: row || null });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// PUT /api/ledger/bets/:id/note — body: { text } — creates or updates the one note for this bet
router.put('/bets/:id/note', (req, res) => {
  try {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'Note text is required' });
    db.prepare(
      `INSERT INTO bet_notes (bet_id, text, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(bet_id) DO UPDATE SET text = excluded.text, updated_at = datetime('now')`
    ).run(req.params.id, text);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// DELETE /api/ledger/bets/:id/note
router.delete('/bets/:id/note', (req, res) => {
  try {
    db.prepare(`DELETE FROM bet_notes WHERE bet_id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/bets/:id/winnings — for sheets with no win/loss result concept (e.g.
// SharpBetting multis), where P/L is simply Winnings - Stake, entered directly once the
// bet's outcome is known. Sets result to won/lost purely so it leaves the "open" bucket on
// the Dashboard — there's no actual Win/Loss/Placed choice being made here. Properly
// reverses whatever was previously applied before reapplying the new figures, same as every
// other settlement path.
router.patch('/bets/:id/winnings', (req, res) => {
  const doSettle = db.transaction((betId, winnings) => {
    const bet = db.prepare(`SELECT * FROM bets WHERE id = ?`).get(betId);
    if (!bet) throw new Error('Bet not found');
    const legs = db.prepare(`SELECT * FROM bet_legs WHERE bet_id = ?`).all(betId);
    const fields = JSON.parse(bet.fields);
    const freeBet = hasNoRealStake(bet.bet_type, fields);
    const newPl = +(winnings - bet.total_stake).toFixed(2);
    const newResult = newPl >= 0 ? 'won' : 'lost';

    if (bet.result !== 'open') {
      for (const leg of legs) {
        const stakeComponent = freeBet ? 0 : leg.stake;
        db.prepare(`UPDATE accounts SET balance = balance - ? - ?, updated_at = datetime('now') WHERE id = ?`)
          .run(stakeComponent, leg.leg_pl || 0, leg.account_id);
      }
    }
    for (const leg of legs) {
      const share = bet.total_stake > 0 ? leg.stake / bet.total_stake : 0;
      const legPl = +(newPl * share).toFixed(2);
      db.prepare(`UPDATE bet_legs SET settled = 1, leg_pl = ? WHERE id = ?`).run(legPl, leg.id);
      const stakeComponent = freeBet ? 0 : leg.stake;
      db.prepare(`UPDATE accounts SET balance = balance + ? + ?, updated_at = datetime('now') WHERE id = ?`)
        .run(stakeComponent, legPl, leg.account_id);
    }

    fields['Winnings'] = winnings;
    db.prepare(`UPDATE bets SET result = ?, pl = ?, fields = ?, settled_at = datetime('now') WHERE id = ?`).run(newResult, newPl, JSON.stringify(fields), betId);
    return newPl;
  });

  try {
    const winnings = parseFloat(req.body.winnings);
    if (isNaN(winnings) || winnings < 0) return res.status(400).json({ ok: false, error: 'winnings must be a number of 0 or more' });
    const pl = doSettle(req.params.id, winnings);
    res.json({ ok: true, pl });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

router.patch('/bets/:id/settle', (req, res) => {
  const settleBet = db.transaction((betId, result, pl, extraFields) => {
    const bet = db.prepare(`SELECT * FROM bets WHERE id = ?`).get(betId);
    if (!bet) throw new Error('Bet not found');
    if (bet.bet_type === 'Back & Lay') throw new Error('Back & Lay bets settle through PATCH /bets/:id/settle-backlay, not this endpoint.');

    const legs = db.prepare(`SELECT * FROM bet_legs WHERE bet_id = ?`).all(betId);

    // Merge any corrections (BFEX SP, a corrected Bet Type, etc) in first, so free-bet
    // status reflects the bet as it now stands, not as it was before this save.
    const parsed = JSON.parse(bet.fields);
    if (extraFields && Object.keys(extraFields).length) Object.assign(parsed, extraFields);
    const freeBet = hasNoRealStake(bet.bet_type, parsed);
    // Free Bet is SNR — no real stake was ever removed at creation, so settlement should
    // only ever move the P/L itself, never a stake component.

    // Overriding an already-settled bet (including returning it to open): reverse each
    // leg's previous effect on its account balance first, so nothing double-counts.
    if (bet.result !== 'open') {
      for (const leg of legs) {
        const stakeComponent = freeBet ? 0 : leg.stake;
        db.prepare(`UPDATE accounts SET balance = balance - ? - ?, updated_at = datetime('now') WHERE id = ?`)
          .run(stakeComponent, leg.leg_pl || 0, leg.account_id);
      }
    }

    if (result === 'open') {
      // Returning to open — nothing gets re-applied, legs go back to unsettled.
      for (const leg of legs) {
        db.prepare(`UPDATE bet_legs SET settled = 0, leg_pl = 0 WHERE id = ?`).run(leg.id);
        if (!freeBet) {
          db.prepare(`UPDATE accounts SET balance = balance + ?, updated_at = datetime('now') WHERE id = ?`)
            .run(leg.stake, leg.account_id);
        }
      }
      // If this bet was staked by someone, reverse whatever was previously applied to
      // their debt too — it's genuinely unsettled now, nothing should still be owed from it.
      const stakeLinkOpen = db.prepare(`SELECT * FROM bet_external_stakes WHERE bet_id = ?`).get(betId);
      if (stakeLinkOpen && bet.result !== 'open') {
        db.prepare(`UPDATE debts SET balance = balance - ?, updated_at = datetime('now') WHERE name = ?`).run(bet.pl, stakeLinkOpen.person);
        db.prepare(`INSERT INTO debt_transactions (person, type, amount, reason, linked_bet_id) VALUES (?, 'stake_for_me', ?, ?, ?)`)
          .run(stakeLinkOpen.person, -bet.pl, 'Bet returned to open', betId);
      }
      db.prepare(`UPDATE bets SET result = 'open', pl = 0, fields = ?, settled_at = NULL WHERE id = ?`).run(JSON.stringify(parsed), betId);
      return;
    }

    for (const leg of legs) {
      const share = bet.total_stake > 0 ? leg.stake / bet.total_stake : 0;
      const legPl = pl * share;
      db.prepare(`UPDATE bet_legs SET settled = 1, leg_pl = ? WHERE id = ?`).run(legPl, leg.id);
      const stakeComponent = freeBet ? 0 : leg.stake;
      db.prepare(`UPDATE accounts SET balance = balance + ? + ?, updated_at = datetime('now') WHERE id = ?`)
        .run(stakeComponent, legPl, leg.account_id);
    }

    // If someone staked this bet, adjust their debt by the change in P/L — reversing
    // whatever was previously applied (if this is an override of an already-settled bet)
    // and applying the new figure. debt += pl matches the agreed rule exactly for both a
    // win (pl is the positive net profit) and a loss (pl is the negative stake amount).
    const stakeLink = db.prepare(`SELECT * FROM bet_external_stakes WHERE bet_id = ?`).get(betId);
    if (stakeLink) {
      const previousPl = bet.result !== 'open' ? bet.pl : 0;
      const delta = pl - previousPl;
      if (delta !== 0) {
        db.prepare(`UPDATE debts SET balance = balance + ?, updated_at = datetime('now') WHERE name = ?`).run(delta, stakeLink.person);
        db.prepare(`INSERT INTO debt_transactions (person, type, amount, reason, linked_bet_id) VALUES (?, 'stake_for_me', ?, ?, ?)`)
          .run(stakeLink.person, delta, `Bet settled: ${result}`, betId);
      }
    }

    // BFEX SP acts as fair odds once filled in — standard value-betting EV: Stake × (Odds/FairOdds - 1).
    if (typeof extraFields['BFEX SP'] === 'number' && extraFields['BFEX SP'] > 0 && typeof parsed.Odds === 'number' && bet.total_stake > 0) {
      parsed['EV'] = +(bet.total_stake * (parsed.Odds / extraFields['BFEX SP'] - 1)).toFixed(2);
    }

    // Bet Type corrected (Offers Normal <-> Free Bet) — recompute EV with the right formula.
    if (extraFields['Bet Type'] && typeof parsed.Odds === 'number' && typeof parsed.Fairs === 'number' && bet.total_stake > 0) {
      parsed['EV'] = +(freeBet
        ? bet.total_stake * (parsed.Odds - 1) / parsed.Fairs
        : bet.total_stake * (parsed.Odds / parsed.Fairs - 1)
      ).toFixed(2);
    }

    db.prepare(`UPDATE bets SET result = ?, pl = ?, fields = ?, settled_at = datetime('now') WHERE id = ?`).run(result, pl, JSON.stringify(parsed), betId);
  });

  try {
    const { result, pl, extraFields } = req.body;
    if (!['won', 'lost', 'void', 'placed', 'open'].includes(result)) return res.status(400).json({ ok: false, error: 'result must be won, lost, placed, void, or open' });
    if (result !== 'open' && typeof pl !== 'number') return res.status(400).json({ ok: false, error: 'pl must be a number' });
    settleBet(req.params.id, result, pl || 0, extraFields || {});
    const bet = db.prepare(`SELECT * FROM bets WHERE id = ?`).get(req.params.id);
    res.json({ ok: true, bet: { ...bet, fields: JSON.parse(bet.fields) } });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// DELETE /api/ledger/bets/:id — removes the bet entirely, correctly reversing whatever
// balance effect it currently has on any linked account. A still-open bet only had its
// stake deducted at creation, so that gets given back. An already-settled bet had both the
// creation deduction AND the settlement payout applied — net effect was just the P/L, so
// only that gets reversed (undoing both halves at once).
router.delete('/bets/:id', (req, res) => {
  const deleteBet = db.transaction((betId) => {
    const bet = db.prepare(`SELECT * FROM bets WHERE id = ?`).get(betId);
    if (!bet) throw new Error('Bet not found');
    const legs = db.prepare(`SELECT * FROM bet_legs WHERE bet_id = ?`).all(betId);
    const freeBet = hasNoRealStake(bet.bet_type, bet.fields);
    for (const leg of legs) {
      if (bet.result === 'open') {
        if (!freeBet) {
          db.prepare(`UPDATE accounts SET balance = balance + ?, updated_at = datetime('now') WHERE id = ?`)
            .run(legCommitted(leg), leg.account_id);
        }
      } else {
        db.prepare(`UPDATE accounts SET balance = balance - ?, updated_at = datetime('now') WHERE id = ?`)
          .run(leg.leg_pl || 0, leg.account_id);
      }
    }
    db.prepare(`DELETE FROM bet_legs WHERE bet_id = ?`).run(betId);
    db.prepare(`DELETE FROM bets WHERE id = ?`).run(betId);
  });

  try {
    deleteBet(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/bets/:id/stake — corrects a bet's stake after the fact (e.g. the actual
// matched amount on BFEX didn't match what was logged). P/L is rescaled by the same ratio —
// mathematically correct since P/L is linear in stake for a fixed odds/result — and any
// linked account balance is properly reversed and reapplied to match the new figures.
// PATCH /api/ledger/bets/:id/field — body: { key, value }. Generic single-field correction
// for anything that isn't the stake column (which has its own dedicated endpoint above,
// since editing stake needs to proportionally rescale P/L and correct account balance).
// Recalculates EV automatically when Odds, Fair Odds/Fairs, or Bet Type change and a full
// Odds+FairOdds+Stake pairing is present — that's a safe, well-defined formula that never
// touches money.
//
// Also recalculates P/L (and adjusts account balance to match), but ONLY for the one case
// where the correct formula is completely unambiguous: a currently-Won, non-each-way bet,
// where Win P/L is always Stake × (Odds - 1) regardless of bet type or free-bet status
// (a free bet's win payout is identical to a normal one — only its loss differs). For any
// other result (Lost/Void/Placed) or an each-way type, P/L is deliberately left alone —
// those formulas depend on result type and bet type in ways that would risk moving real
// money incorrectly if guessed generically. Use the Settle/Override modal for those.
const FIELD_EDIT_EACH_WAY_TYPES = ['Dogs + Horses', 'Dogs + Horses (VA)', 'BB Horse', 'BB Golf', 'BB - RTP'];
router.patch('/bets/:id/field', (req, res) => {
  const doEdit = db.transaction((betId, key, value) => {
    const bet = db.prepare(`SELECT * FROM bets WHERE id = ?`).get(betId);
    if (!bet) throw new Error('Bet not found');
    const fields = JSON.parse(bet.fields);

    // Preserve the existing value's type (number stays a number) where sensible.
    const prevVal = fields[key];
    const numVal = parseFloat(value);
    fields[key] = (typeof prevVal === 'number' && !isNaN(numVal)) ? numVal : value;

    const recalcKeys = ['Odds', 'Fair Odds', 'Fairs', 'Bet Type'];
    if (recalcKeys.includes(key)) {
      const fairVal = typeof fields.Fairs === 'number' ? fields.Fairs : (typeof fields['Fair Odds'] === 'number' ? fields['Fair Odds'] : null);
      const evKey = ('EV £' in fields) ? 'EV £' : ('EV' in fields ? 'EV' : null);
      if (evKey && typeof fields.Odds === 'number' && fairVal && bet.total_stake > 0) {
        const isFreeBet = fields['Bet Type'] === 'Free Bet';
        fields[evKey] = +(isFreeBet
          ? bet.total_stake * (fields.Odds - 1) / fairVal
          : bet.total_stake * (fields.Odds / fairVal - 1)
        ).toFixed(2);
      }
    }

    let newPl = null;
    if (key === 'Odds' && bet.result === 'won' && !FIELD_EDIT_EACH_WAY_TYPES.includes(bet.bet_type) && typeof fields.Odds === 'number' && bet.total_stake > 0) {
      newPl = +(bet.total_stake * (fields.Odds - 1)).toFixed(2);
      const plDelta = newPl - bet.pl;
      const legs = db.prepare(`SELECT * FROM bet_legs WHERE bet_id = ?`).all(betId);
      for (const leg of legs) {
        const share = bet.total_stake > 0 ? leg.stake / bet.total_stake : 0;
        const legPlDelta = +(plDelta * share).toFixed(2);
        db.prepare(`UPDATE bet_legs SET leg_pl = leg_pl + ? WHERE id = ?`).run(legPlDelta, leg.id);
        db.prepare(`UPDATE accounts SET balance = balance + ?, updated_at = datetime('now') WHERE id = ?`).run(legPlDelta, leg.account_id);
      }
    }

    db.prepare(`UPDATE bets SET fields = ?, pl = ? WHERE id = ?`).run(JSON.stringify(fields), newPl !== null ? newPl : bet.pl, betId);
    return { fields, pl: newPl !== null ? newPl : bet.pl };
  });

  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ ok: false, error: 'key is required' });
    const result = doEdit(req.params.id, key, value);
    res.json({ ok: true, fields: result.fields, pl: result.pl });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

router.patch('/bets/:id/stake', (req, res) => {
  const updateStake = db.transaction((betId, newStake) => {
    const bet = db.prepare(`SELECT * FROM bets WHERE id = ?`).get(betId);
    if (!bet) throw new Error('Bet not found');
    const oldStake = bet.total_stake;
    const ratio = oldStake > 0 ? newStake / oldStake : 1;
    const newPl = bet.result === 'open' ? 0 : +(bet.pl * ratio).toFixed(2);

    const legs = db.prepare(`SELECT * FROM bet_legs WHERE bet_id = ?`).all(betId);
    const freeBet = hasNoRealStake(bet.bet_type, bet.fields);
    for (const leg of legs) {
      const newLegStake = +(leg.stake * ratio).toFixed(2);
      const newLegPl = leg.settled ? +((leg.leg_pl || 0) * ratio).toFixed(2) : 0;
      const oldStakeComponent = freeBet ? 0 : leg.stake;
      const newStakeComponent = freeBet ? 0 : newLegStake;
      if (bet.result !== 'open') {
        // Reverse the old net effect (stake + P/L already applied), apply the new one.
        db.prepare(`UPDATE accounts SET balance = balance - ? - ? + ? + ?, updated_at = datetime('now') WHERE id = ?`)
          .run(oldStakeComponent, leg.leg_pl || 0, newStakeComponent, newLegPl, leg.account_id);
      } else {
        // Still open — only the initial stake deduction has happened, adjust just that.
        db.prepare(`UPDATE accounts SET balance = balance - ? + ?, updated_at = datetime('now') WHERE id = ?`)
          .run(oldStakeComponent, newStakeComponent, leg.account_id);
      }
      db.prepare(`UPDATE bet_legs SET stake = ?, leg_pl = ? WHERE id = ?`).run(newLegStake, newLegPl, leg.id);
    }

    // Also update whichever stake-like key sits in the stored fields, so the displayed
    // table cell matches too, not just the underlying total_stake column.
    const fields = JSON.parse(bet.fields);
    const stakeKey = Object.keys(fields).find(k => k.toLowerCase().replace(/[^a-z]/g,'') === 'stake' || k.toLowerCase().replace(/[^a-z]/g,'') === 'totalstake');
    if (stakeKey) fields[stakeKey] = newStake;

    // EV is linear in stake for every formula used across every bet type (standard,
    // each-way, SNR free bet, blended) — so rescaling by the same ratio as P/L is always
    // correct here, without needing to know which specific formula produced it originally.
    const evKey = ('EV £' in fields) ? 'EV £' : ('EV' in fields ? 'EV' : null);
    if (evKey && typeof fields[evKey] === 'number') fields[evKey] = +(fields[evKey] * ratio).toFixed(2);

    db.prepare(`UPDATE bets SET total_stake = ?, pl = ?, fields = ? WHERE id = ?`).run(newStake, newPl, JSON.stringify(fields), betId);
    return newPl;
  });

  try {
    const newStake = parseFloat(req.body.stake);
    if (!(newStake > 0)) return res.status(400).json({ ok: false, error: 'stake must be a positive number' });
    const newPl = updateStake(req.params.id, newStake);
    res.json({ ok: true, pl: newPl });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/bets/:id/casino-balance — corrects any of the four Casino balance
// fields (Wager/Bonus Starting/Finish Balance). Total P/L is recomputed from the four
// values, and any linked account balance is properly adjusted to match the new figure.
const CASINO_BALANCE_KEYS = ['Wager Starting Balance', 'Wager Finish Balance', 'Bonus Starting Balance', 'Bonus Finish Balance'];
router.patch('/bets/:id/casino-balance', (req, res) => {
  const updateBalance = db.transaction((betId, newVals) => {
    const bet = db.prepare(`SELECT * FROM bets WHERE id = ?`).get(betId);
    if (!bet) throw new Error('Bet not found');
    const fields = JSON.parse(bet.fields);

    CASINO_BALANCE_KEYS.forEach(k => { if (newVals[k] !== undefined) fields[k] = newVals[k]; });

    const wagerStart = fields['Wager Starting Balance'] || 0;
    const wagerEnd = fields['Wager Finish Balance'] || 0;
    const bonusStart = fields['Bonus Starting Balance'] || 0;
    const bonusEnd = fields['Bonus Finish Balance'] || 0;
    const newPl = +(((wagerEnd - wagerStart) + (bonusEnd - bonusStart))).toFixed(2);

    const legs = db.prepare(`SELECT * FROM bet_legs WHERE bet_id = ?`).all(betId);
    const totalLegStake = legs.reduce((s, l) => s + l.stake, 0);
    let newResult = bet.result;

    if (bet.result !== 'open') {
      // Already settled — this is a correction. Reverse the old P/L, apply the new one.
      for (const leg of legs) {
        const share = totalLegStake > 0 ? leg.stake / totalLegStake : (legs.length ? 1 / legs.length : 0);
        const newLegPl = +(newPl * share).toFixed(2);
        db.prepare(`UPDATE accounts SET balance = balance - ? + ?, updated_at = datetime('now') WHERE id = ?`)
          .run(leg.leg_pl || 0, newLegPl, leg.account_id);
        db.prepare(`UPDATE bet_legs SET leg_pl = ? WHERE id = ?`).run(newLegPl, leg.id);
      }
    } else {
      // Real Casino offers can be bonus-only or wager-only — requiring all four
      // unconditionally left bets with a genuinely untouched pair stuck on Open forever.
      // Settling once either pair is complete (treating the other, if untouched, as
      // contributing £0) is the safer failure mode: it can always be corrected later if
      // the other pair does get filled in, whereas staying stuck open has no path to
      // self-correct at all.
      const wagerPairComplete = typeof fields['Wager Starting Balance'] === 'number' && typeof fields['Wager Finish Balance'] === 'number';
      const bonusPairComplete = typeof fields['Bonus Starting Balance'] === 'number' && typeof fields['Bonus Finish Balance'] === 'number';
      if (wagerPairComplete || bonusPairComplete) {
        // All four balance fields are now complete for the first time — this is the actual
        // moment of settlement. Without this branch the bet stayed on Open forever and its
        // P/L never reached the account, since the block above only ever ran for bets that
        // were already settled.
        newResult = newPl > 0 ? 'won' : newPl < 0 ? 'lost' : 'void';
        for (const leg of legs) {
          const share = totalLegStake > 0 ? leg.stake / totalLegStake : (legs.length ? 1 / legs.length : 0);
          const newLegPl = +(newPl * share).toFixed(2);
          db.prepare(`UPDATE accounts SET balance = balance + ?, updated_at = datetime('now') WHERE id = ?`)
            .run(newLegPl, leg.account_id);
          db.prepare(`UPDATE bet_legs SET settled = 1, leg_pl = ? WHERE id = ?`).run(newLegPl, leg.id);
        }
        db.prepare(`UPDATE bets SET result = ?, pl = ?, fields = ?, settled_at = datetime('now') WHERE id = ?`).run(newResult, newPl, JSON.stringify(fields), betId);
        return { pl: newPl, result: newResult };
      }
      // Still genuinely incomplete — save the value, no balance change yet, correctly
      // matching the original intent (nothing should move until all four are in).
    }

    db.prepare(`UPDATE bets SET pl = ?, fields = ? WHERE id = ?`).run(newPl, JSON.stringify(fields), betId);
    return { pl: newPl, result: newResult };
  });

  try {
    const result = updateBalance(req.params.id, req.body || {});
    res.json({ ok: true, pl: result.pl, result: result.result });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// GET /api/ledger/bets/open-summary — per bet_type counts of open bets, for building the
// Open Bets page's tab bar (only showing types that actually have something open).
// ================== CUSTOM SHEETS (user-defined bet trackers) ==================
const CUSTOM_SHEET_COLUMN_TYPES = [
  'Date', 'Result', 'Account ID', 'Bookie', 'Bet Type', 'Bet Description',
  'Bet 1', 'Bet 2', 'Bet 3', 'Bet 4', 'Bet 5', 'Bet 6',
  'Back Odds', 'Fair Odds', 'Stake', 'Winnings', 'EV', 'P/L', 'Custom'
];

router.get('/custom-sheets', (req, res) => {
  try {
    const rows = db.prepare(`SELECT * FROM custom_sheets ORDER BY created_at`).all();
    res.json({ ok: true, sheets: rows.map(r => ({ ...r, columns: JSON.parse(r.columns) })) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/custom-sheets — body: { key, user_group, columns: [{type, label?}, ...] }
router.post('/custom-sheets', (req, res) => {
  try {
    const { key, user_group, columns } = req.body;
    if (!key || !key.trim()) return res.status(400).json({ ok: false, error: 'Sheet name is required' });
    if (!['buzzer', 'assistant'].includes(user_group)) return res.status(400).json({ ok: false, error: 'user_group must be buzzer or assistant' });
    if (req.userRole === 'staff' && user_group === 'buzzer') return res.status(403).json({ ok: false, error: 'Staff can only create Assistant sheets.' });
    if (!Array.isArray(columns) || !columns.length) return res.status(400).json({ ok: false, error: 'At least one column is required' });
    for (const c of columns) {
      if (!CUSTOM_SHEET_COLUMN_TYPES.includes(c.type)) return res.status(400).json({ ok: false, error: `Unrecognised column type: ${c.type}` });
      if (c.type === 'Custom' && (!c.label || !c.label.trim())) return res.status(400).json({ ok: false, error: 'Custom columns need a name' });
      if (c.type === 'Custom' && c.isDropdown && (!Array.isArray(c.options) || !c.options.length)) return res.status(400).json({ ok: false, error: `"${c.label}" is set as a dropdown but has no options` });
    }
    const existing = db.prepare(`SELECT 1 FROM custom_sheets WHERE key = ?`).get(key.trim());
    if (existing) return res.status(409).json({ ok: false, error: `A sheet named "${key.trim()}" already exists` });
    db.prepare(`INSERT INTO custom_sheets (key, user_group, columns) VALUES (?, ?, ?)`).run(key.trim(), user_group, JSON.stringify(columns));
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// PUT /api/ledger/custom-sheets/:key — corrects an existing sheet's column definitions.
// Doesn't touch any bets already logged under it; only affects the form/tracker going
// forward.
router.put('/custom-sheets/:key', (req, res) => {
  try {
    const { columns } = req.body;
    const existing = db.prepare(`SELECT * FROM custom_sheets WHERE key = ?`).get(req.params.key);
    if (!existing) return res.status(404).json({ ok: false, error: 'Sheet not found' });
    if (!Array.isArray(columns) || !columns.length) return res.status(400).json({ ok: false, error: 'At least one column is required' });
    for (const c of columns) {
      if (!CUSTOM_SHEET_COLUMN_TYPES.includes(c.type)) return res.status(400).json({ ok: false, error: `Unrecognised column type: ${c.type}` });
      if (c.type === 'Custom' && (!c.label || !c.label.trim())) return res.status(400).json({ ok: false, error: 'Custom columns need a name' });
      if (c.type === 'Custom' && c.isDropdown && (!Array.isArray(c.options) || !c.options.length)) return res.status(400).json({ ok: false, error: `"${c.label}" is set as a dropdown but has no options` });
    }
    db.prepare(`UPDATE custom_sheets SET columns = ? WHERE key = ?`).run(JSON.stringify(columns), req.params.key);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// ================== BANKROLL BREAKDOWN ==================

function computeLiquidBankroll() {
  const bankTotal = db.prepare(`SELECT COALESCE(SUM(starting_balance),0) t FROM banks`).get().t;
  const accountTotal = db.prepare(`SELECT COALESCE(SUM(balance),0) t FROM accounts WHERE status NOT IN ('closed')`).get().t;
  return bankTotal + accountTotal;
}

function computeBankrollFigures() {
  const liquid = computeLiquidBankroll();
  const manual = db.prepare(`SELECT * FROM bankroll_manual ORDER BY category, label`).all();
  const totals = { savings: 0, pension: 0, misc: 0 };
  manual.forEach(m => { if (totals[m.category] !== undefined) totals[m.category] += m.amount; });
  const debts = db.prepare(`SELECT * FROM debts ORDER BY name`).all();
  const debtTotal = debts.reduce((s, d) => s + d.balance, 0);
  const netAsset = liquid + totals.savings + totals.pension + totals.misc + debtTotal;
  return { liquid, manual, totals, debts, debtTotal, netAsset };
}

// Takes a monthly snapshot if today is the last day of the month (or later) and this month
// hasn't been captured yet, and backfills the previous month too if nobody visited on its
// last day. Uses current live figures — for the current month that's exactly what's wanted
// if it genuinely is the last day; the backfill for a missed previous month is a best-effort
// approximation rather than a true point-in-time capture, since there's no scheduler on this
// server to guarantee an exact-midnight snapshot.
function maybeSnapshotBankroll() {
  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7); // 'YYYY-MM'
  const isLastDayOrLater = (() => {
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return now.getDate() >= lastDay;
  })();
  const figures = computeBankrollFigures();
  const snapshotRow = (month) => {
    const exists = db.prepare(`SELECT 1 FROM bankroll_snapshots WHERE month = ?`).get(month);
    if (exists) return;
    db.prepare(
      `INSERT INTO bankroll_snapshots (month, liquid_bankroll, net_asset, savings_total, pension_total, misc_total, debt_total)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(month, figures.liquid, figures.netAsset, figures.totals.savings, figures.totals.pension, figures.totals.misc, figures.debtTotal);
  };
  if (isLastDayOrLater) snapshotRow(thisMonth);
  // Backfill last month if it was never captured (nobody visited on its last day).
  const prevMonthDate = new Date(now.getFullYear(), now.getMonth(), 0);
  const prevMonth = prevMonthDate.toISOString().slice(0, 7);
  const prevExists = db.prepare(`SELECT 1 FROM bankroll_snapshots WHERE month = ?`).get(prevMonth);
  if (!prevExists && now.getDate() <= 5) snapshotRow(prevMonth); // only backfill in the first few days of a new month
}

// GET /api/ledger/bankroll — live figures + manual entries + debts + snapshot history
router.get('/bankroll', (req, res) => {
  try {
    maybeSnapshotBankroll();
    const figures = computeBankrollFigures();
    const kellyStake = figures.liquid * 0.10;
    const snapshots = db.prepare(`SELECT * FROM bankroll_snapshots ORDER BY month DESC LIMIT 24`).all();
    res.json({ ok: true, ...figures, kellyStake, snapshots });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/bankroll/manual — body: { category, label, amount }. Upserts by
// category+label so re-saving the same line item updates it rather than duplicating.
router.post('/bankroll/manual', (req, res) => {
  try {
    const { category, label, amount } = req.body;
    if (!['savings', 'pension', 'misc'].includes(category)) return res.status(400).json({ ok: false, error: 'category must be savings, pension, or misc' });
    if (!label || !label.trim()) return res.status(400).json({ ok: false, error: 'label is required' });
    const amt = parseFloat(amount) || 0;
    const existing = db.prepare(`SELECT id FROM bankroll_manual WHERE category = ? AND label = ?`).get(category, label.trim());
    if (existing) {
      db.prepare(`UPDATE bankroll_manual SET amount = ?, updated_at = datetime('now') WHERE id = ?`).run(amt, existing.id);
    } else {
      db.prepare(`INSERT INTO bankroll_manual (category, label, amount) VALUES (?, ?, ?)`).run(category, label.trim(), amt);
    }
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

router.delete('/bankroll/manual/:id', (req, res) => {
  try {
    db.prepare(`DELETE FROM bankroll_manual WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/debts — body: { name }. Adds a new person, starting at £0.
router.post('/debts', (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ ok: false, error: 'name is required' });
    db.prepare(`INSERT INTO debts (name, balance) VALUES (?, 0) ON CONFLICT(name) DO NOTHING`).run(name.trim());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/debts/:name — body: { amount, reason }. Directly adjusts a person's
// balance by a signed amount (positive = they now owe more), recording it in history same
// as every other debt-affecting event.
router.patch('/debts/:name', (req, res) => {
  const doAdjust = db.transaction((name, amount, reason) => {
    const existing = db.prepare(`SELECT * FROM debts WHERE name = ?`).get(name);
    if (!existing) throw new Error('Person not found');
    db.prepare(`UPDATE debts SET balance = balance + ?, updated_at = datetime('now') WHERE name = ?`).run(amount, name);
    db.prepare(`INSERT INTO debt_transactions (person, type, amount, reason) VALUES (?, 'transaction', ?, ?)`).run(name, amount, reason || '');
  });
  try {
    const amount = parseFloat(req.body.amount);
    if (isNaN(amount) || amount === 0) return res.status(400).json({ ok: false, error: 'amount must be a non-zero number' });
    doAdjust(req.params.name, amount, req.body.reason);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// GET /api/ledger/debt-transactions?person=X (optional — omit for everyone)
router.get('/debt-transactions', (req, res) => {
  try {
    const { person } = req.query;
    const rows = person
      ? db.prepare(`SELECT * FROM debt_transactions WHERE person = ? ORDER BY date DESC LIMIT 500`).all(person)
      : db.prepare(`SELECT * FROM debt_transactions ORDER BY date DESC LIMIT 500`).all();
    res.json({ ok: true, transactions: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ================== SPENDINGS (Bankroll Breakdown page) ==================

// GET /api/ledger/spendings
router.get('/spendings', (req, res) => {
  try {
    const rows = db.prepare(`SELECT * FROM spendings ORDER BY date DESC LIMIT 500`).all();
    res.json({ ok: true, spendings: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/spendings — body: { bank, direction, amount, details }. Moves money
// in/out of the given bank's live balance, same as a bank transaction, and records it
// permanently in this separate personal-spending history.
router.post('/spendings', (req, res) => {
  const doAdd = db.transaction((bank, direction, amount, details) => {
    const delta = direction === 'in' ? amount : -amount;
    db.prepare(`UPDATE banks SET starting_balance = starting_balance + ? WHERE name = ?`).run(delta, bank);
    const info = db.prepare(`INSERT INTO spendings (bank, direction, amount, details) VALUES (?, ?, ?, ?)`).run(bank, direction, amount, details || '');
    return info.lastInsertRowid;
  });
  try {
    const { bank, direction, amount, details } = req.body;
    if (!bank || !bank.trim()) return res.status(400).json({ ok: false, error: 'bank is required' });
    if (!['in', 'out'].includes(direction)) return res.status(400).json({ ok: false, error: 'direction must be in or out' });
    const amt = parseFloat(amount);
    if (!(amt > 0)) return res.status(400).json({ ok: false, error: 'amount must be a positive number' });
    const bankExists = db.prepare(`SELECT 1 FROM banks WHERE name = ?`).get(bank.trim());
    if (!bankExists) return res.status(400).json({ ok: false, error: `Bank "${bank.trim()}" not found` });
    const id = doAdd(bank.trim(), direction, amt, details);
    res.json({ ok: true, id });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/spendings/:id — corrects the amount, adjusting the bank balance by the
// difference in the correct direction.
router.patch('/spendings/:id', (req, res) => {
  const doEdit = db.transaction((id, newAmount) => {
    const row = db.prepare(`SELECT * FROM spendings WHERE id = ?`).get(id);
    if (!row) throw new Error('Spending entry not found');
    const diff = newAmount - row.amount;
    const delta = row.direction === 'in' ? diff : -diff;
    db.prepare(`UPDATE banks SET starting_balance = starting_balance + ? WHERE name = ?`).run(delta, row.bank);
    db.prepare(`UPDATE spendings SET amount = ? WHERE id = ?`).run(newAmount, id);
  });
  try {
    const newAmount = parseFloat(req.body.amount);
    if (!(newAmount > 0)) return res.status(400).json({ ok: false, error: 'amount must be a positive number' });
    doEdit(req.params.id, newAmount);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// DELETE /api/ledger/spendings/:id — reverses its effect on the bank balance and removes it.
router.delete('/spendings/:id', (req, res) => {
  const doDelete = db.transaction((id) => {
    const row = db.prepare(`SELECT * FROM spendings WHERE id = ?`).get(id);
    if (!row) throw new Error('Spending entry not found');
    const delta = row.direction === 'in' ? -row.amount : row.amount;
    db.prepare(`UPDATE banks SET starting_balance = starting_balance + ? WHERE name = ?`).run(delta, row.bank);
    db.prepare(`DELETE FROM spendings WHERE id = ?`).run(id);
  });
  try {
    doDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// ================== EXTERNAL STAKING ==================

// POST /api/ledger/bet-external-stakes — body: { bet_id, person }. Links an already-created
// real bet to the person who staked it, so settling it through the normal Settle modal
// later also adjusts their debt automatically.
router.post('/bet-external-stakes', (req, res) => {
  try {
    const { bet_id, person } = req.body;
    if (!bet_id || !person || !person.trim()) return res.status(400).json({ ok: false, error: 'bet_id and person are required' });
    db.prepare(`INSERT INTO bet_external_stakes (bet_id, person) VALUES (?, ?)`).run(bet_id, person.trim());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// GET /api/ledger/external-stakes?status=open|settled (optional)
router.get('/external-stakes', (req, res) => {
  try {
    const { status } = req.query;
    const rows = status
      ? db.prepare(`SELECT es.*, a.account_id AS account_code, a.bookie FROM external_stakes es JOIN accounts a ON a.id = es.account_id WHERE es.result = ? ORDER BY es.date DESC`).all(status === 'open' ? 'open' : status)
      : db.prepare(`SELECT es.*, a.account_id AS account_code, a.bookie FROM external_stakes es JOIN accounts a ON a.id = es.account_id ORDER BY es.date DESC LIMIT 500`).all();
    res.json({ ok: true, stakes: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/external-stakes — "staked by me": places real money from one of our
// accounts on someone else's behalf. Deducts the account balance for the stake (it's
// genuinely leaving the account), but does NOT create a bet — this never counts toward
// monthly P&L, it's tracked entirely here.
router.post('/external-stakes', (req, res) => {
  const doCreate = db.transaction((person, accountId, betDescription, odds, stake) => {
    const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
    if (!account) throw new Error('Account not found');
    db.prepare(`UPDATE accounts SET balance = balance - ?, updated_at = datetime('now') WHERE id = ?`).run(stake, accountId);
    const info = db.prepare(
      `INSERT INTO external_stakes (person, account_id, bet_description, odds, stake) VALUES (?, ?, ?, ?, ?)`
    ).run(person, accountId, betDescription, odds, stake);
    return info.lastInsertRowid;
  });
  try {
    const { person, account_id, bet_description, odds, stake } = req.body;
    if (!person || !person.trim()) return res.status(400).json({ ok: false, error: 'person is required' });
    if (!account_id) return res.status(400).json({ ok: false, error: 'account_id is required' });
    const oddsNum = parseFloat(odds), stakeNum = parseFloat(stake);
    if (!(oddsNum > 1)) return res.status(400).json({ ok: false, error: 'odds must be greater than 1' });
    if (!(stakeNum > 0)) return res.status(400).json({ ok: false, error: 'stake must be a positive number' });
    const id = doCreate(person.trim(), account_id, bet_description || '', oddsNum, stakeNum);
    res.json({ ok: true, id });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/external-stakes/:id/settle — body: { result: 'won'|'lost'|'open' }.
// Standard win/loss formula (this is a simple tracked stake, not a full bet with all the
// each-way/free-bet complexity). debt -= pl matches the agreed "staked by me" rule exactly
// — win decreases their debt by the profit, loss increases it by the stake. Properly
// reverses whatever was previously applied if this is a re-settle.
router.patch('/external-stakes/:id/settle', (req, res) => {
  const doSettle = db.transaction((id, result) => {
    const stake = db.prepare(`SELECT * FROM external_stakes WHERE id = ?`).get(id);
    if (!stake) throw new Error('External stake not found');
    const newPl = result === 'won' ? +(stake.stake * (stake.odds - 1)).toFixed(2) : result === 'lost' ? -stake.stake : 0;

    if (stake.result !== 'open') {
      // Reverse whatever was previously applied to their debt.
      db.prepare(`UPDATE debts SET balance = balance + ?, updated_at = datetime('now') WHERE name = ?`).run(stake.pl, stake.person);
    }
    if (result !== 'open') {
      db.prepare(`UPDATE debts SET balance = balance - ?, updated_at = datetime('now') WHERE name = ?`).run(newPl, stake.person);
      db.prepare(`INSERT INTO debt_transactions (person, type, amount, reason, linked_external_stake_id) VALUES (?, 'stake_by_me', ?, ?, ?)`)
        .run(stake.person, -newPl, `External stake settled: ${result}`, id);
    }
    db.prepare(`UPDATE external_stakes SET result = ?, pl = ?, settled_at = ? WHERE id = ?`)
      .run(result, newPl, result === 'open' ? null : new Date().toISOString(), id);
  });
  try {
    const { result } = req.body;
    if (!['won', 'lost', 'open'].includes(result)) return res.status(400).json({ ok: false, error: 'result must be won, lost, or open' });
    doSettle(req.params.id, result);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// DELETE /api/ledger/external-stakes/:id — for one added in error. Reverses the account
// deduction (if still open) or the settled effect (if already settled) before deleting.
router.delete('/external-stakes/:id', (req, res) => {
  const doDelete = db.transaction((id) => {
    const stake = db.prepare(`SELECT * FROM external_stakes WHERE id = ?`).get(id);
    if (!stake) throw new Error('External stake not found');
    if (stake.result === 'open') {
      db.prepare(`UPDATE accounts SET balance = balance + ?, updated_at = datetime('now') WHERE id = ?`).run(stake.stake, stake.account_id);
    } else {
      db.prepare(`UPDATE accounts SET balance = balance - ?, updated_at = datetime('now') WHERE id = ?`).run(stake.pl, stake.account_id);
      db.prepare(`UPDATE debts SET balance = balance + ?, updated_at = datetime('now') WHERE name = ?`).run(stake.pl, stake.person);
    }
    db.prepare(`DELETE FROM external_stakes WHERE id = ?`).run(id);
  });
  try {
    doDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/debt-transactions — plain "Add Transaction": body { person, direction,
// amount, reason }. direction 'from' = money from them (their debt increases), 'to' =
// money to them (their debt decreases) — matching the agreed sign convention exactly.
router.post('/debt-transactions', (req, res) => {
  const doAdd = db.transaction((person, signedAmount, reason) => {
    const existing = db.prepare(`SELECT 1 FROM debts WHERE name = ?`).get(person);
    if (!existing) throw new Error('Person not found — add them first');
    db.prepare(`UPDATE debts SET balance = balance + ?, updated_at = datetime('now') WHERE name = ?`).run(signedAmount, person);
    db.prepare(`INSERT INTO debt_transactions (person, type, amount, reason) VALUES (?, 'transaction', ?, ?)`).run(person, signedAmount, reason || '');
  });
  try {
    const { person, direction, amount, reason } = req.body;
    if (!person || !person.trim()) return res.status(400).json({ ok: false, error: 'person is required' });
    if (!['to', 'from'].includes(direction)) return res.status(400).json({ ok: false, error: 'direction must be to or from' });
    const amt = parseFloat(amount);
    if (!(amt > 0)) return res.status(400).json({ ok: false, error: 'amount must be a positive number' });
    const signedAmount = direction === 'from' ? amt : -amt;
    doAdd(person.trim(), signedAmount, reason || '');
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// ================== ASSISTANT TO-DO ==================

// GET /api/ledger/todos?status=open|completed|problem (optional — omit for everything)
router.get('/todos', (req, res) => {
  try {
    const { status } = req.query;
    const rows = status
      ? db.prepare(`SELECT * FROM todos WHERE status = ? ORDER BY created_at DESC`).all(status)
      : db.prepare(`SELECT * FROM todos ORDER BY created_at DESC LIMIT 500`).all();
    res.json({ ok: true, todos: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/todos — body: { note, urgency }. Admin only.
router.post('/todos', requireAdmin, (req, res) => {
  try {
    const { note, urgency } = req.body;
    if (!note || !note.trim()) return res.status(400).json({ ok: false, error: 'note is required' });
    if (!['asap', 'today', 'week', 'whenever'].includes(urgency)) return res.status(400).json({ ok: false, error: 'urgency must be asap, today, week, or whenever' });
    const info = db.prepare(`INSERT INTO todos (note, urgency, created_by) VALUES (?, ?, ?)`).run(note.trim(), urgency, req.username || null);
    pushNotification('todo', 'staff', 'To Do request received', note.trim());
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/todos/:id/complete
router.patch('/todos/:id/complete', (req, res) => {
  try {
    db.prepare(`UPDATE todos SET status = 'completed', completed_at = datetime('now') WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/todos/:id/problem — body: { problem_note } (optional)
router.patch('/todos/:id/problem', (req, res) => {
  try {
    const { problem_note } = req.body;
    db.prepare(`UPDATE todos SET status = 'problem', problem_note = ? WHERE id = ?`).run(problem_note || null, req.params.id);
    pushNotification('todo', 'admin', 'Problem flagged on a To Do request', problem_note || null);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/todos/:id/reopen — puts a completed/problem item back to open, in case
// either side needs to undo a mistaken action.
router.patch('/todos/:id/reopen', (req, res) => {
  try {
    db.prepare(`UPDATE todos SET status = 'open', completed_at = NULL, problem_note = NULL WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// DELETE /api/ledger/todos/:id — Admin only, for clearing out resolved items.
router.delete('/todos/:id', requireAdmin, (req, res) => {
  try {
    db.prepare(`DELETE FROM todos WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ================== NOTIFICATION FEED (header bell) ==================

// Insert one row into the notification feed. Best-effort — a feed write must never break the
// action that triggered it, so failures are swallowed. Shared by the To-Do hooks above; the
// lineup poller (notifications-poller.js) writes its own rows directly against the same table.
function pushNotification(type, audience, title, body) {
  try {
    db.prepare(`INSERT INTO notifications (type, audience, title, body) VALUES (?, ?, ?, ?)`)
      .run(type, audience || 'all', title, body || null);
  } catch (e) { /* non-fatal */ }
}

// GET /api/ledger/notifications — the header bell's feed. Open to every role (Calculator
// included, via the gate exception above). Rows older than 24h are pruned on read, giving
// the "clears every day" behaviour without a scheduler. audience gates visibility:
//   admin  -> all + admin + staff (nothing Staff sees is hidden from Admin)
//   staff  -> all + staff
//   others -> all only
router.get('/notifications', (req, res) => {
  try {
    db.prepare(`DELETE FROM notifications WHERE created_at < datetime('now', '-24 hours')`).run();
    db.prepare(`DELETE FROM lineup_notify_state WHERE notified_at < datetime('now', '-24 hours')`).run();
    const audiences = req.userRole === 'admin' ? ['all', 'admin', 'staff']
      : req.userRole === 'staff' ? ['all', 'staff']
      : ['all'];
    const placeholders = audiences.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, type, title, body, created_at FROM notifications
       WHERE audience IN (${placeholders}) ORDER BY id DESC LIMIT 200`
    ).all(...audiences);
    res.json({ ok: true, notifications: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ================== MATCH PREDICTIONS (Today's Matches corner/pen takers) ==================
//
// GET /api/ledger/match-predictions?date=YYYYMMDD
// For every fixture that day: lineup-confirmed status for each side (drives the green team
// names) plus, once a side's XI is confirmed, predicted corner taker(s) and penalty taker
// from the corner-model. corner-model/ is deployed separately to the DO box (like oc-scraper)
// so its absence is non-fatal — the route still returns lineup status.
const cornerModel = (() => {
  try { return require('./corner-model/predict'); }
  catch (e) { console.error('[match-predictions] corner-model not loaded:', e.message); return null; }
})();

// matchDetails fetch with a short in-memory TTL cache — pre-match lineups flip
// predicted -> confirmed, so this is deliberately NOT the immutable disk cache.
const _mpFotmobHdrs = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json', 'Referer': 'https://www.fotmob.com/',
};
const _mpLineupCache = new Map(); // matchId -> { at, lineup }
async function mpGetLineup(matchId) {
  const hit = _mpLineupCache.get(String(matchId));
  if (hit && Date.now() - hit.at < 150000) return hit.lineup;
  let lineup = null;
  try {
    const r = await fetch(`https://www.fotmob.com/api/data/matchDetails?matchId=${matchId}`, { headers: _mpFotmobHdrs });
    if (r.ok) { const d = await r.json(); lineup = d && d.content && d.content.lineup || null; }
  } catch (e) { /* leave null */ }
  _mpLineupCache.set(String(matchId), { at: Date.now(), lineup });
  return lineup;
}

const _mpPredCache = new Map(); // `${matchId}|${lineupType}` -> { home, away }
const _fixturesHandler = require('./netlify/functions/fixtures').handler;

function mpSide(lineupSide, confirmed) {
  const teamId = lineupSide ? String(lineupSide.id) : null;
  const teamName = lineupSide ? lineupSide.name : null;
  let cornerTakers = null, penTaker = null, cornerThreat = null;
  if (confirmed && teamId && cornerModel && lineupSide && Array.isArray(lineupSide.starters)) {
    const xi = lineupSide.starters.map(p => ({ id: p.id, name: p.name, positionId: p.positionId }));
    try {
      const p = cornerModel.predictForTeam({ teamId, xi, asOfDate: new Date().toISOString() });
      cornerTakers = p.cornerTakers; penTaker = p.penTaker; cornerThreat = p.cornerThreat;
    } catch (e) { cornerTakers = [{ name: 'error', pct: 0, side: null, note: e.message }]; }
  }
  return { teamId, teamName, lineupConfirmed: !!confirmed, cornerTakers, penTaker, cornerThreat };
}

router.get('/match-predictions', async (req, res) => {
  try {
    const date = String(req.query.date || '').replace(/[^0-9]/g, '')
      || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const fxRaw = await _fixturesHandler({ httpMethod: 'GET', queryStringParameters: { date } });
    let fx = null; try { fx = JSON.parse(fxRaw.body); } catch (e) {}
    if (!fx || !fx.ok || !Array.isArray(fx.leagues)) return res.json({ ok: true, date, matches: [] });

    const fixtures = [];
    for (const lg of fx.leagues) for (const m of (lg.matches || [])) fixtures.push(m);

    const matches = [];
    // small concurrency pool over the lineup fetches
    for (let i = 0; i < fixtures.length; i += 8) {
      const slice = fixtures.slice(i, i + 8);
      await Promise.all(slice.map(async m => {
        const lu = await mpGetLineup(m.id);
        const lineupType = lu && lu.lineupType || 'none';
        const confirmed = !!lu && lineupType !== 'predicted' && lineupType !== 'none';
        const cacheKey = `${m.id}|${lineupType}`;
        let pred = _mpPredCache.get(cacheKey);
        if (!pred) {
          pred = { home: mpSide(lu && lu.homeTeam, confirmed), away: mpSide(lu && lu.awayTeam, confirmed) };
          // fill team names from the fixture when there's no lineup object yet
          if (!pred.home.teamName) pred.home.teamName = m.home;
          if (!pred.away.teamName) pred.away.teamName = m.away;
          _mpPredCache.set(cacheKey, pred);
        }
        matches.push({ matchId: String(m.id), home: pred.home, away: pred.away });
      }));
    }
    // keep the pred cache from growing unbounded across days
    if (_mpPredCache.size > 400) _mpPredCache.clear();
    res.json({ ok: true, date, matches });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ================== FOTMOB LEAGUES (Today's Matches league list) ==================

// GET /api/ledger/fotmob-leagues
router.get('/fotmob-leagues', (req, res) => {
  try {
    const leagues = db.prepare(`SELECT * FROM fotmob_leagues ORDER BY league_name`).all();
    res.json({ ok: true, leagues });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/fotmob-leagues — body: { league_id, league_name }. Open to any role —
// Edit Leagues is a Calculations tool, not a financial action, so it isn't Admin-gated.
router.post('/fotmob-leagues', (req, res) => {
  try {
    const { league_id, league_name } = req.body;
    if (!league_id || !String(league_id).trim()) return res.status(400).json({ ok: false, error: 'league_id is required' });
    if (!league_name || !league_name.trim()) return res.status(400).json({ ok: false, error: 'league_name is required' });
    const existing = db.prepare(`SELECT 1 FROM fotmob_leagues WHERE league_id = ?`).get(String(league_id).trim());
    if (existing) return res.status(409).json({ ok: false, error: `League ID ${league_id} is already in the list` });
    db.prepare(`INSERT INTO fotmob_leagues (league_id, league_name) VALUES (?, ?)`).run(String(league_id).trim(), league_name.trim());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// DELETE /api/ledger/fotmob-leagues/:id — :id is the row id, not the FotMob league_id. Open
// to any role — see note on the POST route above.
router.delete('/fotmob-leagues/:id', (req, res) => {
  try {
    db.prepare(`DELETE FROM fotmob_leagues WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/bets/open-summary', (req, res) => {
  try {
    const rows = db.prepare(`SELECT bet_type, COUNT(*) c FROM bets WHERE result = 'open' GROUP BY bet_type ORDER BY bet_type`).all();
    res.json({ ok: true, types: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ================== ACCOUNT SUMMARY ==================

// GET /api/ledger/account-summary?bookie=PaddyPower (optional — omit for every bookie)
// Counts every account ever created for that bookie (any status, matching "accounts used"
// as a historical/cumulative figure, not just currently-live ones).
router.get('/account-summary', (req, res) => {
  try {
    const { bookie } = req.query;
    const bookies = bookie ? [bookie] : db.prepare(`SELECT DISTINCT bookie FROM accounts ORDER BY bookie`).all().map(r => r.bookie);

    const summary = bookies.map(b => {
      const accountsUsed = db.prepare(`SELECT COUNT(*) c FROM accounts WHERE bookie = ?`).get(b).c;
      const totalDeposits = db.prepare(
        `SELECT COALESCE(SUM(d.amount),0) t FROM deposits d JOIN accounts a ON a.id=d.account_id WHERE a.bookie = ?`
      ).get(b).t;
      const totalWithdrawals = db.prepare(
        `SELECT COALESCE(SUM(w.amount),0) t FROM withdrawals w JOIN accounts a ON a.id=w.account_id WHERE a.bookie = ?`
      ).get(b).t;
      const pl = db.prepare(
        `SELECT COALESCE(SUM(bl.leg_pl),0) t FROM bet_legs bl JOIN accounts a ON a.id=bl.account_id WHERE a.bookie = ? AND bl.settled = 1`
      ).get(b).t;
      return { bookie: b, accountsUsed, totalDeposits, totalWithdrawals, pl };
    });

    res.json({ ok: true, summary });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ================== BALANCES (grid-friendly) ==================

// GET /api/ledger/balances — same shape as accounts, trimmed for the Live Balances grid
router.get('/balances', (req, res) => {
  try {
    const accounts = db.prepare(`SELECT id, profile, bookie, status, balance FROM accounts ORDER BY profile, bookie`).all();
    const rows = accounts.map(a => ({ ...a, open_stake: openStakeFor(a.id) }));
    res.json({ ok: true, balances: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ================== BOOKIE AUTOFILL SETTINGS ==================
// Purely a site-side registry for Bulk Account Entry's "no specific book" mode.
// The Accounts Google Sheet is write-only from the app's side and is never read back.

// GET /api/ledger/bookie-settings
router.get('/bookie-settings', (req, res) => {
  try {
    const rows = db.prepare(`SELECT bookie, autofill_enabled FROM bookie_settings ORDER BY bookie`).all();
    res.json({ ok: true, bookies: rows.map(r => ({ bookie: r.bookie, autofill_enabled: !!r.autofill_enabled })) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/ledger/bookie-settings — body: { bookie, autofill_enabled? }
router.post('/bookie-settings', (req, res) => {
  try {
    const { bookie, autofill_enabled = false } = req.body;
    if (!bookie || !bookie.trim()) return res.status(400).json({ ok: false, error: 'bookie required' });
    db.prepare(
      `INSERT INTO bookie_settings (bookie, autofill_enabled) VALUES (?, ?)
       ON CONFLICT(bookie) DO UPDATE SET autofill_enabled = excluded.autofill_enabled, updated_at = datetime('now')`
    ).run(bookie.trim(), autofill_enabled ? 1 : 0);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// PATCH /api/ledger/bookie-settings/:bookie — body: { autofill_enabled }
router.patch('/bookie-settings/:bookie', (req, res) => {
  try {
    const { autofill_enabled } = req.body;
    const info = db.prepare(
      `UPDATE bookie_settings SET autofill_enabled = ?, updated_at = datetime('now') WHERE bookie = ?`
    ).run(autofill_enabled ? 1 : 0, req.params.bookie);
    if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Bookie not found in settings' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// DELETE /api/ledger/bookie-settings/:bookie
router.delete('/bookie-settings/:bookie', (req, res) => {
  try {
    db.prepare(`DELETE FROM bookie_settings WHERE bookie = ?`).run(req.params.bookie);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

module.exports = router;

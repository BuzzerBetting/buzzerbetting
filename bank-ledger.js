// Bank ledger (2026-10-08, user-requested) — the Money page, for Jordan and Kieran separately:
// every bank and category has an owner and each of them only ever sees their own. — every movement in or out of Jordan's
// own banks that isn't a bookie deposit/withdrawal (those stay automatic): transfers between his
// banks, transfers to someone else, money in (refund, interest ...) and money out (bracketed
// spending categories), each with an optional note. Every entry moves banks.starting_balance —
// the bank's live balance everywhere else on the site — straight away; a transfer between two
// of his banks is one row that moves both sides.
//
// Accuracy: "Set real balance" on a bank the first time records its opening balance (the one
// big reset). After that a re-set is stored as a 'correction' entry, and balance-integrity.js
// rebuilds each bank from opening balance + entries + bookie deposits/withdrawals since, logging
// any gap to the Account Balance Error Log.
const db = require('./ledger-db');

db.exec(`
CREATE TABLE IF NOT EXISTS bank_categories (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  owner   TEXT,                       -- username
  kind    TEXT NOT NULL,              -- 'in' | 'out'
  name    TEXT NOT NULL,
  bracket TEXT,                       -- out only: 'essential' | 'non_essential' | 'business'
  sort    INTEGER NOT NULL DEFAULT 0,
  active  INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS bank_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bank        TEXT NOT NULL,
  type        TEXT NOT NULL,          -- 'own_transfer' | 'to_person' | 'in' | 'out' | 'correction'
  category_id INTEGER,
  to_bank     TEXT,                   -- own_transfer only
  person      TEXT,                   -- to_person / money in from someone
  amount      REAL NOT NULL,          -- positive; a correction is signed (actual − site balance)
  note        TEXT NOT NULL DEFAULT '',
  date        TEXT NOT NULL DEFAULT (datetime('now')),  -- when it happened (editable)
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bank_entries_bank ON bank_entries (bank, date);
CREATE TABLE IF NOT EXISTS bank_checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bank       TEXT NOT NULL,
  site       REAL NOT NULL,           -- the site's balance at the time
  actual     REAL NOT NULL,           -- what the bank app showed
  action     TEXT NOT NULL,           -- 'opening' | 'matched' | 'corrected'
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
for (const col of ['opening_balance REAL', 'opening_at TEXT', 'last_checked_at TEXT', 'owner TEXT']) {
  try { db.exec(`ALTER TABLE banks ADD COLUMN ${col}`); } catch (e) { /* already exists */ }
}
try { db.exec(`ALTER TABLE bank_categories ADD COLUMN owner TEXT`); } catch (e) { /* already exists */ }
// Every bank that existed before owners did is Jordan's (the bookie accounts' banks).
db.prepare(`UPDATE banks SET owner = 'Jordan' WHERE owner IS NULL`).run();
const BANK_USERS = ['Jordan', 'Kieran'];
// confirmed_at lets the bank check tell a withdrawal confirmed after a bank's opening balance
// from one confirmed before it. Rows confirmed before the column existed are back-filled with
// their own date (always before any opening balance, which can only be set from now on).
try { db.exec(`ALTER TABLE withdrawals ADD COLUMN confirmed_at TEXT`); } catch (e) { /* already exists */ }
db.prepare(`UPDATE withdrawals SET confirmed_at = date WHERE status = 'confirmed' AND confirmed_at IS NULL`).run();

// Each user starts with the same default categories, then edits their own.
function ensureCategories(owner) {
  if (db.prepare(`SELECT COUNT(*) n FROM bank_categories WHERE owner = ?`).get(owner).n) return;
  const ins = db.prepare(`INSERT INTO bank_categories (owner, kind, name, bracket, sort) VALUES (?, ?, ?, ?, ?)`);
  [
    ['out', 'Essential food', 'essential'], ['out', 'Non-essential food', 'non_essential'], ['out', 'Fuel', 'essential'],
    ['out', 'Bills & utilities', 'essential'], ['out', 'Rent / housing', 'essential'], ['out', 'Subscriptions', 'non_essential'],
    ['out', 'Betting costs', 'business'], ['out', 'Staff costs', 'business'],
    ['out', 'Essential other', 'essential'], ['out', 'Non-essential other', 'non_essential'],
    ['in', 'Refund', null], ['in', 'Transfer from someone', null], ['in', 'Interest', null], ['in', 'Income', null],
    ['in', 'Cashback', null], ['in', 'Other', null],
  ].forEach(([k, n, b], i) => ins.run(owner, k, n, b, i));
}
BANK_USERS.forEach(ensureCategories);

const TYPES = ['own_transfer', 'to_person', 'in', 'out'];
const round2 = n => Math.round(n * 100) / 100;

// The balance effect of one entry, per bank: [[bank, delta], ...].
function effects(e) {
  if (e.type === 'own_transfer') return [[e.bank, -e.amount], [e.to_bank, e.amount]];
  if (e.type === 'in') return [[e.bank, e.amount]];
  if (e.type === 'correction') return [[e.bank, e.amount]];
  return [[e.bank, -e.amount]]; // out, to_person
}
function apply(e, sign) {
  const up = db.prepare(`UPDATE banks SET starting_balance = starting_balance + ? WHERE name = ?`);
  for (const [bank, d] of effects(e)) up.run(sign * d, bank);
}

function ownsBank(owner, name) { return !!db.prepare(`SELECT 1 FROM banks WHERE name = ? AND owner = ?`).get(name, owner); }
function ownedEntry(owner, id) {
  const row = db.prepare(`SELECT * FROM bank_entries WHERE id = ?`).get(id);
  if (!row || !ownsBank(owner, row.bank)) throw new Error('Entry not found');
  return row;
}

const addEntry = db.transaction((owner, b) => {
  const username = owner;
  const type = b.type;
  if (!TYPES.includes(type)) throw new Error('type must be own_transfer, to_person, in or out');
  const amount = round2(parseFloat(b.amount));
  if (!(amount > 0)) throw new Error('amount must be a positive number');
  if (!ownsBank(owner, b.bank)) throw new Error('Bank not found');
  let toBank = null, person = null, categoryId = null;
  if (type === 'own_transfer') {
    toBank = b.to_bank;
    if (!ownsBank(owner, toBank)) throw new Error('Receiving bank not found');
    if (toBank === b.bank) throw new Error('Pick a different receiving bank');
  } else {
    if (b.category_id != null && b.category_id !== '') {
      const cat = db.prepare(`SELECT * FROM bank_categories WHERE id = ? AND owner = ?`).get(Number(b.category_id), owner);
      if (!cat) throw new Error('Category not found');
      const wantKind = type === 'in' ? 'in' : 'out';
      if (cat.kind !== wantKind) throw new Error(`That category is for money ${cat.kind}`);
      categoryId = cat.id;
    } else if (type === 'in' || type === 'out') {
      throw new Error('Pick a category');
    }
    person = (b.person || '').trim() || null;
    if (type === 'to_person' && !person) throw new Error('Who was it sent to?');
  }
  const date = b.date ? String(b.date).replace('T', ' ').slice(0, 19) : null;
  const info = db.prepare(`INSERT INTO bank_entries (bank, type, category_id, to_bank, person, amount, note, date, created_by)
                           VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?)`)
    .run(b.bank, type, categoryId, toBank, person, amount, (b.note || '').trim(), date, username || null);
  const row = db.prepare(`SELECT * FROM bank_entries WHERE id = ?`).get(info.lastInsertRowid);
  apply(row, 1);
  return row;
});

const deleteEntry = db.transaction((owner, id) => {
  const row = ownedEntry(owner, id);
  apply(row, -1);
  db.prepare(`DELETE FROM bank_entries WHERE id = ?`).run(id);
});

// Edit note / date / category / person freely; an amount change moves the balance by the difference.
const editEntry = db.transaction((owner, id, b) => {
  const row = ownedEntry(owner, id);
  if (row.type === 'correction' && b.amount !== undefined) throw new Error('Corrections can only be deleted, not edited');
  const next = { ...row };
  if (b.note !== undefined) next.note = String(b.note || '').trim();
  if (b.date) next.date = String(b.date).replace('T', ' ').slice(0, 19);
  if (b.person !== undefined) next.person = (b.person || '').trim() || null;
  if (b.category_id !== undefined && row.type !== 'own_transfer' && row.type !== 'correction') {
    const cat = db.prepare(`SELECT * FROM bank_categories WHERE id = ? AND owner = ?`).get(Number(b.category_id), owner);
    if (!cat || cat.kind !== (row.type === 'in' ? 'in' : 'out')) throw new Error('Category not valid for this entry');
    next.category_id = cat.id;
  }
  if (b.amount !== undefined) {
    const a = round2(parseFloat(b.amount));
    if (!(a > 0)) throw new Error('amount must be a positive number');
    apply(row, -1); next.amount = a; apply(next, 1);
  }
  db.prepare(`UPDATE bank_entries SET note = ?, date = ?, person = ?, category_id = ?, amount = ? WHERE id = ?`)
    .run(next.note, next.date, next.person, next.category_id, next.amount, id);
});

// "Set real balance": first time = the bank's opening balance; afterwards a correction entry.
// matchedOnly = the bank app agrees with the site, just stamp the check.
const setRealBalance = db.transaction((owner, bank, actual) => {
  const username = owner;
  const b = db.prepare(`SELECT * FROM banks WHERE name = ? AND owner = ?`).get(bank, owner);
  if (!b) throw new Error('Bank not found');
  const site = round2(b.starting_balance);
  actual = round2(actual);
  if (!b.opening_at) {
    db.prepare(`UPDATE banks SET starting_balance = ?, opening_balance = ?, opening_at = datetime('now'), last_checked_at = datetime('now') WHERE name = ?`).run(actual, actual, bank);
    db.prepare(`INSERT INTO bank_checks (bank, site, actual, action, created_by) VALUES (?, ?, ?, 'opening', ?)`).run(bank, site, actual, username || null);
    return { action: 'opening', site, actual };
  }
  const diff = round2(actual - site);
  if (Math.abs(diff) < 0.005) {
    db.prepare(`UPDATE banks SET last_checked_at = datetime('now') WHERE name = ?`).run(bank);
    db.prepare(`INSERT INTO bank_checks (bank, site, actual, action, created_by) VALUES (?, ?, ?, 'matched', ?)`).run(bank, site, actual, username || null);
    return { action: 'matched', site, actual };
  }
  const info = db.prepare(`INSERT INTO bank_entries (bank, type, amount, note, created_by) VALUES (?, 'correction', ?, ?, ?)`)
    .run(bank, diff, `Set to real balance £${actual.toFixed(2)} (site had £${site.toFixed(2)})`, username || null);
  apply(db.prepare(`SELECT * FROM bank_entries WHERE id = ?`).get(info.lastInsertRowid), 1);
  db.prepare(`UPDATE banks SET last_checked_at = datetime('now') WHERE name = ?`).run(bank);
  db.prepare(`INSERT INTO bank_checks (bank, site, actual, action, created_by) VALUES (?, ?, ?, 'corrected', ?)`).run(bank, site, actual, username || null);
  return { action: 'corrected', site, actual, diff };
});

// Expected balance for every bank that has an opening balance — used by balance-integrity.js.
// opening + this ledger's entries + confirmed bookie withdrawals − bookie deposits, all since
// the opening balance was set. Old-style bank_transactions / bank_transfers / spendings rows
// (retired, never used) are counted too in case one is ever added.
function expectedBanks() {
  const out = [];
  for (const b of db.prepare(`SELECT * FROM banks WHERE opening_at IS NOT NULL`).all()) {
    const since = b.opening_at;
    let exp = b.opening_balance || 0;
    for (const e of db.prepare(`SELECT * FROM bank_entries WHERE (bank = ? OR to_bank = ?) AND created_at >= ?`).all(b.name, b.name, since)) {
      for (const [bank, d] of effects(e)) if (bank === b.name) exp += d;
    }
    exp -= db.prepare(`SELECT COALESCE(SUM(d.amount), 0) s FROM deposits d JOIN accounts a ON a.id = d.account_id WHERE a.profile = ? AND d.created_at >= ?`).get(b.name, since).s;
    exp += db.prepare(`SELECT COALESCE(SUM(w.amount), 0) s FROM withdrawals w JOIN accounts a ON a.id = w.account_id
                       WHERE a.profile = ? AND w.status = 'confirmed' AND w.confirmed_at >= ?`).get(b.name, since).s;
    // Confirmed before the opening balance, reversed after: the reversal took it back out of the bank.
    exp -= db.prepare(`SELECT COALESCE(SUM(w.amount), 0) s FROM withdrawals w JOIN accounts a ON a.id = w.account_id
                       WHERE a.profile = ? AND w.status = 'reversed' AND w.confirmed_at IS NOT NULL AND w.confirmed_at < ? AND w.reversed_at >= ?`).get(b.name, since, since).s;
    exp += db.prepare(`SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END), 0) s FROM bank_transactions WHERE bank = ? AND created_at >= ?`).get(b.name, since).s;
    exp += db.prepare(`SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END), 0) s FROM spendings WHERE bank = ? AND created_at >= ?`).get(b.name, since).s;
    exp += db.prepare(`SELECT COALESCE(SUM(CASE WHEN to_bank = ? THEN amount ELSE -amount END), 0) s FROM bank_transfers WHERE (from_bank = ? OR to_bank = ?) AND created_at >= ?`).get(b.name, b.name, b.name, since).s;
    out.push({ bank: b.name, owner: b.owner, expected: round2(exp), live: round2(b.starting_balance), drift: round2(b.starting_balance - exp) });
  }
  return out;
}

function listBanks(owner) {
  return db.prepare(`SELECT b.name, b.starting_balance AS balance, b.opening_balance, b.opening_at, b.last_checked_at,
                            (SELECT COUNT(*) FROM accounts a WHERE a.profile = b.name AND a.status NOT IN ('closed','locked')) AS live_accounts
                     FROM banks b WHERE b.owner = ? ORDER BY b.name`).all(owner).map(b => ({ ...b, balance: round2(b.balance) }));
}
function listCategories(owner, includeInactive) {
  ensureCategories(owner);
  return db.prepare(`SELECT * FROM bank_categories WHERE owner = ? ${includeInactive ? '' : 'AND active = 1'} ORDER BY kind, sort, id`).all(owner);
}
const OWNED = `(e.bank IN (SELECT name FROM banks WHERE owner = ?))`;
function listEntries(owner, q = {}) {
  const where = [OWNED], p = [owner];
  if (q.bank) { where.push('(e.bank = ? OR e.to_bank = ?)'); p.push(q.bank, q.bank); }
  if (q.type) { where.push('e.type = ?'); p.push(q.type); }
  if (q.category_id) { where.push('e.category_id = ?'); p.push(Number(q.category_id)); }
  if (q.month) { where.push(`strftime('%Y-%m', e.date) = ?`); p.push(q.month); }
  return db.prepare(`SELECT e.*, c.name AS category, c.bracket FROM bank_entries e LEFT JOIN bank_categories c ON c.id = e.category_id
                     WHERE ${where.join(' AND ')} ORDER BY e.date DESC, e.id DESC LIMIT ?`)
    .all(...p, Math.min(Number(q.limit) || 300, 2000));
}
function people(owner) {
  return db.prepare(`SELECT person, COUNT(*) n FROM bank_entries e WHERE person IS NOT NULL AND ${OWNED} GROUP BY person ORDER BY MAX(date) DESC LIMIT 30`).all(owner).map(r => r.person);
}
// Spending report: money out + to someone, by category and month (and money in by category).
function report(owner, months = 6) {
  const m = Math.max(1, Math.min(24, Number(months) || 6));
  const rows = db.prepare(`
    SELECT strftime('%Y-%m', e.date) AS month, e.type, e.category_id, c.name AS category, c.bracket, c.kind, ROUND(SUM(e.amount), 2) AS total, COUNT(*) AS n
    FROM bank_entries e LEFT JOIN bank_categories c ON c.id = e.category_id
    WHERE e.type IN ('out', 'to_person', 'in') AND e.date >= date('now', 'start of month', ?) AND ${OWNED}
    GROUP BY month, e.type, e.category_id ORDER BY month`).all(`-${m - 1} months`, owner);
  return { months: m, rows };
}

function addCategory(owner, b) {
  const kind = b.kind === 'in' ? 'in' : 'out';
  const name = String(b.name || '').trim();
  if (!name) throw new Error('name required');
  const bracket = kind === 'out' ? (['essential', 'non_essential', 'business'].includes(b.bracket) ? b.bracket : 'non_essential') : null;
  const sort = (db.prepare(`SELECT MAX(sort) m FROM bank_categories WHERE kind = ? AND owner = ?`).get(kind, owner).m || 0) + 1;
  return db.prepare(`INSERT INTO bank_categories (owner, kind, name, bracket, sort) VALUES (?, ?, ?, ?, ?)`).run(owner, kind, name, bracket, sort).lastInsertRowid;
}
function editCategory(owner, id, b) {
  const c = db.prepare(`SELECT * FROM bank_categories WHERE id = ? AND owner = ?`).get(id, owner);
  if (!c) throw new Error('Category not found');
  const name = b.name !== undefined ? String(b.name).trim() || c.name : c.name;
  const bracket = c.kind === 'out' && ['essential', 'non_essential', 'business'].includes(b.bracket) ? b.bracket : c.bracket;
  const active = b.active !== undefined ? (b.active ? 1 : 0) : c.active;
  db.prepare(`UPDATE bank_categories SET name = ?, bracket = ?, active = ? WHERE id = ?`).run(name, bracket, active, id);
}
function renameBank(oldName, newName) {
  db.prepare(`UPDATE bank_entries SET bank = ? WHERE bank = ?`).run(newName, oldName);
  db.prepare(`UPDATE bank_entries SET to_bank = ? WHERE to_bank = ?`).run(newName, oldName);
  db.prepare(`UPDATE bank_checks SET bank = ? WHERE bank = ?`).run(newName, oldName);
}

// A bank of the user's own. Names are unique across everyone (banks.name is the key).
function addBank(owner, name) {
  name = String(name || '').trim();
  if (!name) throw new Error('Bank name required');
  if (db.prepare(`SELECT 1 FROM banks WHERE name = ?`).get(name)) throw new Error(`A bank called "${name}" already exists — pick another name`);
  db.prepare(`INSERT INTO banks (name, starting_balance, owner) VALUES (?, 0, ?)`).run(name, owner);
}

module.exports = {
  BANK_USERS, addBank, ownsBank,
  addEntry, deleteEntry, editEntry, setRealBalance, expectedBanks, listBanks, listCategories, listEntries, people, report,
  addCategory, editCategory, renameBank, effects,
};

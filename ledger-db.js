// ledger-db.js
// Initializes (or opens) the Ledger SQLite database on the DO server.
// Requires: npm install better-sqlite3 --save
//
// Usage in your main server file:
//   const db = require('./ledger-db');

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'ledger.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // safer under concurrent reads/writes

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT,               -- the human-readable ID, e.g. 'D014' or 'C001'. D-series are globally
                                  -- unique forever; C-series are unique per bookie only (reusable across
                                  -- different bookies). Enforced in application code, see ledger-routes.js.
  profile TEXT NOT NULL,         -- repurposed as "linked bank" — e.g. 'Rev 1', 'Monzo 2'
  bookie TEXT NOT NULL,          -- e.g. 'SkyBet', 'Betfair'
  account_name TEXT DEFAULT '',  -- legacy field, no longer collected — personal identity names live only
                                  -- in the external Account Bank sheet, never in this database
  label TEXT DEFAULT '',         -- optional, disambiguates 2+ accounts on the same profile+bookie
  status TEXT NOT NULL DEFAULT 'good',
    -- one of: good, restricted, closed, locked. Closed/locked accounts are kept (not deleted)
    -- — needed for the account_id uniqueness check and per-bookie counts — but are filtered
    -- out of Live Accounts.
  note TEXT DEFAULT '',
  balance REAL NOT NULL DEFAULT 0,
  starting_balance REAL DEFAULT 0, -- balance at publish time; kept separate from 'balance' so
                                    -- bank-balance deductions only count genuine deposits/withdrawals,
                                    -- not pre-existing float brought in at Account Entry
  closed_at TEXT,                -- set specifically when marked Finished; used for the 7-day
                                  -- "recently archived" undo window. Cleared if restored.
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount REAL NOT NULL,
  date TEXT NOT NULL DEFAULT (datetime('now')),
  balance_after REAL NOT NULL,
  sheet_row INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount REAL NOT NULL,
  date TEXT NOT NULL DEFAULT (datetime('now')),
  balance_after REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | reversed
  sheet_row INTEGER,                      -- row number on the Withdrawals-Pending sheet tab, for the confirm step
  processed_sheet_row INTEGER,            -- row number on the Withdrawals-Processed sheet tab, once confirmed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bet_type TEXT NOT NULL,       -- e.g. 'Value', 'Keithbot', 'BB Horse', 'Discord'...
  date TEXT NOT NULL DEFAULT (datetime('now')),
  fields TEXT NOT NULL,         -- JSON blob of bet-type-specific fields (Bet, Odds, EV, etc.)
  total_stake REAL NOT NULL,
  result TEXT NOT NULL DEFAULT 'open',  -- open, won, lost, void
  pl REAL DEFAULT 0,
  settled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bet_legs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bet_id INTEGER NOT NULL REFERENCES bets(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  stake REAL NOT NULL,
  leg_pl REAL DEFAULT 0,
  settled INTEGER NOT NULL DEFAULT 0 -- 0 = open, 1 = settled
);

CREATE INDEX IF NOT EXISTS idx_bet_legs_bet ON bet_legs(bet_id);
CREATE INDEX IF NOT EXISTS idx_bet_legs_account ON bet_legs(account_id);
CREATE INDEX IF NOT EXISTS idx_deposits_account ON deposits(account_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_account ON withdrawals(account_id);

-- Registry of bookies known to the site, purely for Bulk Account Entry's "no specific book"
-- mode. Managed entirely on the site — the Accounts Google Sheet is write-only and is never
-- read back, so this list and its toggles live here instead of in the Sheet.
CREATE TABLE IF NOT EXISTS bookie_settings (
  bookie TEXT PRIMARY KEY,
  autofill_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Money moved out of live tracking — either a withdrawal request the bookie refused to pay
-- (confiscated) or a balance manually locked away on an account. Denormalized (not a foreign
-- key to accounts) so the record survives even if the source account is later deleted.
CREATE TABLE IF NOT EXISTS locked_funds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_code TEXT,
  bookie TEXT,
  bank TEXT,
  amount REAL NOT NULL,
  source TEXT NOT NULL, -- 'confiscated_withdrawal' | 'account_locked'
  linked_account_id INTEGER, -- set only for 'account_locked' rows, so Unlock can restore the exact account
  date TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Each bank's own tracked starting balance — the pool that live account balances are
-- notionally drawn from. Live Accounts shows starting_balance minus net deposits/withdrawals
-- across its live accounts, i.e. how much is still sitting uncommitted.
CREATE TABLE IF NOT EXISTS banks (
  name TEXT PRIMARY KEY,
  starting_balance REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Direct money movement in/out of a bank's own pool (not via any betting account) —
-- e.g. topping up a bank, or pulling money out of it. Adjusts banks.starting_balance.
-- Referred to as "External transaction" in the UI.
CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank TEXT NOT NULL,
  amount REAL NOT NULL,      -- always positive; direction stored separately
  direction TEXT NOT NULL,   -- 'in' | 'out'
  reason TEXT DEFAULT '',
  date TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Money moved directly between two banks on the site (not via any betting account).
-- One row per transfer so reversal is a single atomic undo, rather than trying to link
-- two separate bank_transactions rows together.
CREATE TABLE IF NOT EXISTS bank_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_bank TEXT NOT NULL,
  to_bank TEXT NOT NULL,
  amount REAL NOT NULL,
  date TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Free-text notes attached to an account, shown in its detail panel's Notes tab.
CREATE TABLE IF NOT EXISTS account_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_account_notes_account ON account_notes(account_id);

-- One editable note per bet row, shown as a Notes column on the tracker (currently only
-- surfaced for Casino, but the mechanism is generic).
CREATE TABLE IF NOT EXISTS bet_notes (
  bet_id INTEGER PRIMARY KEY REFERENCES bets(id),
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- User-defined bet tracker sheets, created via the Bets page's "Add New Sheet" — the key is
-- used directly as the bet_type string everywhere else (Bet Entry, Bet Tracking, Dashboard).
-- columns is a JSON array of column definitions in display order, e.g.
-- [{"type":"Bookie"},{"type":"Bet Description"},{"type":"Back Odds"},{"type":"Fair Odds"},
--  {"type":"Custom","label":"Selection"}]
CREATE TABLE IF NOT EXISTS custom_sheets (
  key TEXT PRIMARY KEY,
  user_group TEXT NOT NULL,
  columns TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A "card" (C-number) is a physical/virtual deposit card, linked to exactly one bank.
-- It's a standalone entity — created on its own, then referenced by one or more accounts
-- rows (each a specific bookie's account funded by this same card). The same card can back
-- accounts at multiple different bookies; accounts.account_id + accounts.bookie together
-- enforce that it's never used twice for the *same* bookie (see validateAccountId).
CREATE TABLE IF NOT EXISTS cards (
  card_number TEXT PRIMARY KEY,
  bank TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Real per-user accounts, replacing the old shared PIN. passcode_hash is a salted scrypt
-- hash (Node's built-in crypto, no extra dependency), never the plain passcode.
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  passcode_hash TEXT NOT NULL,
  role TEXT NOT NULL, -- 'admin' | 'staff'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Session tokens issued on login. Checked on every role-gated request so restrictions are
-- enforced server-side, not just hidden in the UI.
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL REFERENCES users(username),
  role TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ================== BANKROLL BREAKDOWN ==================
-- Manually-updated figures (Savings/Pension/Misc) — everything else on the page (Liquid
-- Bankroll) is computed live from banks + accounts, not stored here.
CREATE TABLE IF NOT EXISTS bankroll_manual (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL, -- 'savings' | 'pension' | 'misc'
  label TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per person owed to/by. Positive balance = they owe the user, negative = the user
-- owes them.
CREATE TABLE IF NOT EXISTS debts (
  name TEXT PRIMARY KEY,
  balance REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Permanent record of every debt-affecting event — external stakes and plain manual
-- transactions alike — so there's a real audit trail per person, not just a running total.
CREATE TABLE IF NOT EXISTS debt_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person TEXT NOT NULL,
  type TEXT NOT NULL, -- 'stake_for_me' | 'stake_by_me' | 'transaction'
  amount REAL NOT NULL, -- the delta actually applied to their balance (signed)
  reason TEXT NOT NULL DEFAULT '',
  linked_bet_id INTEGER, -- set for stake_for_me, links to the real bet
  linked_external_stake_id INTEGER, -- set for stake_by_me
  date TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- "Staked by me" bets — money placed on someone else's behalf through one of our accounts.
-- Deliberately NOT part of the bets table: it doesn't count toward monthly P&L, and has its
-- own Win/Lose settlement here rather than the normal Settle modal.
CREATE TABLE IF NOT EXISTS external_stakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person TEXT NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  bet_description TEXT NOT NULL DEFAULT '',
  odds REAL NOT NULL,
  stake REAL NOT NULL,
  result TEXT NOT NULL DEFAULT 'open', -- 'open' | 'won' | 'lost'
  pl REAL NOT NULL DEFAULT 0,
  date TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at TEXT
);

-- Links a real bet (someone staked the user, so it IS a genuine bet on our pages) back to
-- the person who funded it, so settling it through the normal Settle modal can also adjust
-- their debt automatically.
CREATE TABLE IF NOT EXISTS bet_external_stakes (
  bet_id INTEGER PRIMARY KEY REFERENCES bets(id),
  person TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per month, captured on (or shortly after) the last day, so Liquid Bankroll growth
-- can be tracked over time rather than only ever showing the current live figure.
CREATE TABLE IF NOT EXISTS bankroll_snapshots (
  month TEXT PRIMARY KEY, -- 'YYYY-MM'
  liquid_bankroll REAL NOT NULL,
  net_asset REAL NOT NULL,
  savings_total REAL NOT NULL,
  pension_total REAL NOT NULL,
  misc_total REAL NOT NULL,
  debt_total REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Personal spending tracker (Bankroll Breakdown page) — money in/out of a specific bank.
-- Structurally similar to bank_transactions (External Transaction, on the Money page) but
-- kept deliberately separate: this is personal spending history, not business/betting bank
-- movements, and mixing the two lists would make both harder to review cleanly.
CREATE TABLE IF NOT EXISTS spendings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank TEXT NOT NULL,
  direction TEXT NOT NULL, -- 'in' | 'out'
  amount REAL NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT (datetime('now')), -- time of entry, recorded automatically
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Admin-to-Assistant requests. status: 'open' -> 'completed' or 'problem'. problem_note is
-- only set when Assistant flags it as a problem, so Admin knows what actually went wrong.
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note TEXT NOT NULL,
  urgency TEXT NOT NULL, -- 'asap' | 'today' | 'week' | 'whenever'
  status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'completed' | 'problem'
  problem_note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- One row per direct balance override — the manual "correct this balance" box on an
-- account, not any normal deposit/withdrawal/bet flow. Kept separate from those so it can
-- be shown clearly in the account's transaction history as its own distinct event type.
CREATE TABLE IF NOT EXISTS manual_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  old_balance REAL NOT NULL,
  new_balance REAL NOT NULL,
  delta REAL NOT NULL,
  created_by TEXT,
  date TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which FotMob leagues Today's Matches pulls fixtures for. Previously hardcoded directly
-- into fixtures.js; now editable via the "Edit Leagues" button, with fixtures.js fetching
-- this list fresh on every request instead of reading a fixed array.
CREATE TABLE IF NOT EXISTS fotmob_leagues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id TEXT NOT NULL UNIQUE,
  league_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- In-app notification feed powering the header bell. Rows are pruned to a rolling 24h on
-- every read (GET /notifications) and by the lineup poller. audience gates who sees a row:
-- 'all' = every role incl. calculator, 'admin'/'staff' = that role (admin also sees staff).
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                     -- 'lineup' | 'todo'
  audience TEXT NOT NULL DEFAULT 'all',   -- 'all' | 'admin' | 'staff'
  title TEXT NOT NULL,
  body TEXT,
  meta TEXT,                              -- JSON, e.g. {"matchId":123}
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Dedupe guard for the server-side lineup poller: one row per match once its "Lineups
-- Confirmed" notification has been emitted, so re-scanning the same match never re-alerts.
-- Pruned to 24h alongside notifications.
CREATE TABLE IF NOT EXISTS lineup_notify_state (
  match_id TEXT PRIMARY KEY,
  notified_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Safe migration — ALTER TABLE ADD COLUMN errors if the column already exists, so this is
// wrapped to silently no-op on every restart after the first. Needed because `withdrawals`
// already existed with live data before this column was added; CREATE TABLE IF NOT EXISTS
// only creates a brand new table, it never adds columns to one that's already there.
try { db.exec(`ALTER TABLE withdrawals ADD COLUMN reversed_at TEXT`); } catch (e) { /* already exists */ }

// Back & Lay support — every other bet type shares one bet-level Odds value across all its
// legs (bets.fields.Odds), but Back & Lay needs its own odds per leg (back accounts and
// exchange accounts are priced independently), plus which side of the bet each leg is on,
// plus a per-exchange-leg commission rate. NULL/unused for every other bet type.
try { db.exec(`ALTER TABLE bet_legs ADD COLUMN role TEXT`); } catch (e) { /* already exists */ }
try { db.exec(`ALTER TABLE bet_legs ADD COLUMN odds REAL`); } catch (e) { /* already exists */ }
try { db.exec(`ALTER TABLE bet_legs ADD COLUMN commission REAL`); } catch (e) { /* already exists */ }

// Free bet (SNR — Stake Not Returned) support for a Back & Lay bet's BOOKIE leg(s) only — the
// exchange/lay leg always risks real liability regardless, so this deliberately lives per-leg
// rather than at the bet level (unlike every other bet type's fields['Bet Type']-driven free
// bet flag, which applies uniformly since those types only have one kind of leg). 0/absent for
// every non-back leg and every other bet type. See legCommitted() in ledger-routes.js.
try { db.exec(`ALTER TABLE bet_legs ADD COLUMN free_bet INTEGER DEFAULT 0`); } catch (e) { /* already exists */ }

module.exports = db;

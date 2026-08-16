BuzzerBetting — Project Context for Claude Code

This document is based on every single file in the repo having now actually been read — no exceptions, no assumptions carried over from earlier guessing. Either edited directly this session, or pasted in specifically for this handoff. One critical, previously-unknown issue was found in the process (§2) — read that section first, it likely explains a recurring problem from earlier in the session and is a genuine blocker for the second deployment currently being set up.

Full repo structure (confirmed via screenshot + every file now read):

netlify/functions/
  accounts-sheet.js   — read. Confirmed DEAD — zero references anywhere in index.html.
  bb-odds.js          — read. Active third-party odds scraper (bookiebashing.net).
  betfair-proxy.js    — read. Proxies to the DO server's own /api/betfair (see §2).
  betfair.js          — read. Real Betfair Exchange API integration (session-token auth).
  betfred.js          — read. Scrapes a Betfred event page's HTML for player odds.
  ddhh.js             — read. Same bookiebashing.net API as bb-odds.js (shared BB_HASH/
                         BB_COOKIES env vars), filtered for isDdHh/isInPlayDdHh matches —
                         powers the DDHH calculator tool specifically.
  fixtures.js         — edited this session (FotMob leagues now DB-driven, see §6).
  ledger.js           — edited this session (DO_HOST/PORT now env-var driven, see §6).
  lineups.js          — read. FotMob lineup fetcher.
  oc-fgs-find.js       — read earlier. Proxies to DO server's /api/oc-fgs-find — NOT mounted
                         anywhere in server.js (see §2, this is part of the same issue).
  oddschecker.js      — edited this session (market IDs now independently optional).
  player-stats.js     — read earlier. FotMob shot-stat scraper for First Goalscorer tool.
  sheets.js           — read. Confirmed ACTIVE — 16 references across index.html, used by
                         an older, parallel Google-Sheets-reading bet-tracking view that
                         coexists alongside the newer database-driven system (see §6).
index.html            — extensively edited this session (~10,700+ lines).
ledger-db.js           — extensively edited this session.
ledger-routes.js       — extensively edited this session.
netlify.toml            — read. Minimal — functions dir + publish root + esbuild bundler.
package.json             — read earlier.
server.js               — read. See §2 — this is the important one.
1. What this project is

BuzzerBetting is a private, internal web application for running a sports betting operation — tracking multiple bookmaker accounts, bank balances, individual bets across many different betting strategies/sheets, staking money for other people, and giving both an Admin (the owner) and Staff (a VA/assistant) role-appropriate access to different parts of the system.

A second, fully independent instance is currently being set up by a second operator ("Kieran") — his own DO server, his own Netlify site, his own database, sharing only the codebase via this GitHub repo. Zero data should ever cross between instances. The finding in §2 is a direct, serious blocker to that effort as it currently stands.

2. RESOLVED — server.js was out of date in GitHub, now corrected

This is fixed, not just diagnosed. The theory below was confirmed by reading the actual live server.js directly from the DO server via SSH — it genuinely did have two extra pieces the GitHub copy was missing:

js
app.use('/api/ledger', ledgerRouter);

and a full inline implementation of /api/oc-fgs-find (not a separate netlify/functions file at all — implemented directly in server.js itself, which is exactly why searching for a corresponding function file never turned it up).

Root cause, now confirmed rather than theorized: at some point, /api/ledger and /api/oc-fgs-find were added directly to the live server's server.js and never committed back to GitHub — so the repo's copy quietly fell behind what was actually running. The corrected, complete file (pulled directly from the live server, validated, attached alongside this report as server.js) has now been pushed to GitHub. Kieran cloning fresh from this point onward will get the real, working entrypoint.

This is also the confirmed, not just suspected, explanation for the recurring "features go missing on the live site" issue from earlier in the session (§9) — the live-vs-repo drift demonstrated here is a real, proven failure mode for this project, not a one-off. Worth treating any future "it worked before, now it doesn't" report with this specific possibility in mind — always diff the live file against the repo directly rather than assuming the repo is current.

3. Architecture — how the pieces fit together
Frontend: index.html, hosted on Netlify. Netlify serves this static file plus most of the serverless functions listed above directly.
Backend (Ledger): an always-on Node/Express server on a DigitalOcean droplet (178.128.40.248:3000 for the owner's instance), kept alive via PM2 (ecosystem.config.js, not in the repo — created fresh per deployment, holds LEDGER_API_KEY). SQLite database via better-sqlite3. This is where ledger-routes.js needs to be mounted — see §2 for the current gap.
A second, distinct role for server.js: independently of the Ledger system, server.js also re-hosts several of the netlify/functions files as plain Express routes on the same DO droplet (/api/betfair, /api/sheets, /api/bb-odds, /api/fixtures, /api/lineups, /api/oddschecker, /api/player-stats). The clearest reason for this: betfair.js needs a session-token login against the real Betfair Exchange API, which very likely requires a stable, whitelisted IP — something Netlify's serverless functions (ephemeral, rotating IPs) can't reliably provide. betfair-proxy.js confirms this pattern directly — it's a Netlify function whose entire job is to forward requests to the DO server's /api/betfair rather than doing the Betfair call itself. Not fully confirmed for the other re-hosted routes, but the same reasoning likely applies to at least bb-odds.js (needs a persistent session cookie/hash) and possibly others.

How the frontend talks to the Ledger backend: every Ledger request goes through netlify/functions/ledger.js, which proxies to the DO server over plain HTTP, injecting the shared LEDGER_API_KEY secret so it never reaches the browser. fixtures.js separately calls the DO server for one specific feature (the editable FotMob league list, §8).

Architectural gap found and fixed this session (separate from §2): ledger.js and fixtures.js both had the DO server's IP/port hardcoded directly (const DO_HOST = '178.128.40.248') rather than read from an environment variable — any new independent deployment would silently point at the original server unless someone remembered to manually edit that line. Fixed: both now read LEDGER_DO_HOST / LEDGER_DO_PORT from env vars first, falling back to the current hardcoded value only if unset. Zero change required for the existing deployment.

Authentication, two layers:

Server-level: every DO server Ledger request needs a correct x-ledger-key header (the shared secret) or is rejected — checked in middleware inside ledger-routes.js itself, near the top of the file.
Per-user: users/sessions tables, POST /login with username + scrypt-hashed passcode, returning a session token sent as x-session-token on every subsequent call. Resolved server-side to a username + role, enforced on individual routes, not just hidden in the UI.
4. Key backend files
ledger-routes.js (~2,150 lines) — the entire router intended to be mounted at /api/ledger/* (see §2 for the current mounting gap). Every account, bet, deposit, withdrawal, bank, note, todo, and settlement operation lives here.
ledger-db.js — SQLite schema, CREATE TABLE IF NOT EXISTS for new tables plus explicit, safely-guarded ALTER TABLE ADD COLUMN migrations for columns added to tables that already had live data. A fresh database builds itself automatically on first run.
server.js — see §2 and §3. Needs correcting before reuse for a fresh deployment.
ecosystem.config.js — not in the repo, by design (holds secrets). Each deployment creates this fresh, locally, pointing script: 'server.js'.
5. Key frontend structure (index.html)

Single file, everything in it: login screen, home menu branching into Ledger (accounts, bets, bankroll, money movement), Stats (Today's Stats, Monthly Profit, Monthly Probability/Monte Carlo simulation), Calculations (odds tools — talks to the netlify/functions scrapers/proxies directly, not the Ledger backend), and a standalone To Do system between Admin and Staff.

The Ledger section is the bulk of the app: a live Accounts grid (colour-coded by status — Good/Restricted/Locked/Archived/Dormant), a generic database-driven bet-tracking system spanning many "sheets" (Value, Casino, Dogs + Horses/DogBot, Discord, Offers, and others, split into Personal/Buzzer vs VA/Assistant variants where relevant), Bank Balances, Bankroll Breakdown (Kelly staking), External Staking.

Dark mode is a full, working manual toggle, persisted via localStorage, using CSS custom properties under a data-theme="dark" attribute.

6. Role/permission system

Three roles, enforced server-side, not just hidden client-side:

Admin — full access.
Staff — restricted to Assistant-group sheets only; several actions independently blocked server-side via a requireAdmin middleware. One deliberate, narrow exception: Staff can see and settle Admin's open bets from the Dashboard widget specifically, via an explicit query flag, not a general loosening.
Calculator (new this session) — access only to Calculations tools, which don't touch the Ledger backend at all. Blocked from every Ledger endpoint via a blanket router-level middleware — no technical path to any financial data even via direct API calls.
7. Two parallel bet-tracking systems — worth understanding, not necessarily a bug

While verifying sheets.js's usage, it became clear the app currently has two separate bet-tracking display systems coexisting:

The modern, database-driven system (ledger-routes.js + the bt-detail-style frontend code) — this is what essentially all of this session's work targeted: bet entry, settlement, EV calculation, the Casino/DogBot fixes, transaction history, everything in §8 below.
An older system that reads directly from Google Sheets via sheets.js — genuinely still wired up and callable, referenced 16 times across index.html for things like "Overall Profit", "Summary", and several bet-type tabs (Value, American Props, etc.), under what the code labels as "VA SECTIONS". This predates the database migration.

One specific piece of this older system (a dedicated "Dogs + Horses" tracker view, calling sheets.js with tab=Dogs+Horses) was separately confirmed dead this session — but that was one specific view, not the whole sheets.js integration. It's genuinely unclear from the code alone whether the rest of this older, Sheets-reading system is still part of actual day-to-day usage, or is also effectively abandoned but simply hasn't been explicitly retired yet. Worth a direct question to the project owner rather than assuming either way — this determines whether sheets.js should be treated as load-bearing or as a second, larger cleanup candidate alongside the already-confirmed-dead accounts-sheet.js.

CONFIRMED (2026-08-16 session): asked the project owner directly — the sheets.js-based "VA Sections" system is a **confirmed cleanup candidate**, not confirmed load-bearing. It's architecturally live (front-and-center "Data connections" panel in the Bet Tracker hub, 16 references across index.html, not orphaned like accounts-sheet.js), but whether the `bb_main_url`/`bb_va_url` localStorage fields are actually still populated/used day-to-day is not something the code can answer, and the owner explicitly deferred the decision — not removing anything tonight. Treat this as queued for a future session, not urgent (it's inert cruft either way — doesn't touch the DB or the DO server, so it isn't a risk sitting as-is). When picked up: confirm with the owner/VA whether those URL fields are still populated before removing sheets.js or the VA Sections UI.

accounts-sheet.js is confirmed dead — zero references anywhere in index.html. It proxied "Bulk Account Entry" name submissions to a Google Apps Script URL; whatever frontend called it either never existed in the current version or was removed at some point without the corresponding function file being cleaned up.

8. Major work completed this session (roughly chronological)
Full config-driven bet entry/settlement across many sheet types (odds mode, each-way, free-bet/nominal-stake handling, multi-account entry for Casino/DogBot).
Google Sheets integration removed for accounts/deposits/withdrawals specifically (was a parallel write alongside the database; database is now sole source of truth for that data). This did not touch the separate, still-active sheets.js read-only display system described in §7, nor accounts-sheet.js (confirmed separately dead).
Withdrawal timing reworked: account balance deducts at request time, not confirmation — correctly propagated through confirm/reverse/confiscate/recover.
Negative balances allowed everywhere — the MAX(0, ...) floor removed across all ~23 occurrences in the backend.
Real bugs found and fixed:
A phantom permanent £0.01 "open stake" on every account that ever had a VA Casino bet, from the nominal Casino stake never being excluded from the open-stake calculation.
Casino bets could get permanently stuck on "Open" with P&L never reaching the account — the balance-save endpoint only applied money if already settled. Fixed to recognize balance-field completion as the settlement moment. Second gap found after: required all four balance fields, but real offers are often bonus-only or wager-only — fixed to settle once either pair completes.
A withdrawal endpoint stopped returning the account's new balance after the timing rework, silently crashing the UI into a permanent "Processing…" state even though the withdrawal had genuinely succeeded server-side.
A stale DOM reference from a Notes-tab redesign was crashing openAccountModal() before it reached the line that shows the modal — clicking any account did nothing.
Full account transaction history — unified chronological ledger per account, running balance computed backwards from the current trusted balance.
Type-aware reversal system for every transaction type — reversing a "Bet placed" event correctly cascades to delete the entire bet including any settlement.
Manual Adjustment Log — dedicated page of every balance override across every account.
Account Notes reworked — auto-displaying single current note, proper Edit (didn't exist before) and Delete, grid-level "Show notes" toggle.
Dormant account flagging — 60+ days zero activity with balance still present.
New Settlement tab on the account modal — every open bet with a working Settle button; Casino shown as a simple "unfinished" count.
Assistant To-Do system — background polling, audio tone, on-screen toast banner.
FotMob league list made editable via UI — moved from a hardcoded array into the database.
DogBot extended to Assistant side (Dogs + Horses (VA)) — nine separate places, including the server-side permission enforcement list.
New "Calculator" role added (§6).
Dark mode re-enabled as a genuine manual toggle.
oddschecker.js fixed — previously required all four market IDs or silently returned nothing; now each market is independently optional.
9. A recurring deployment issue — now confirmed, not just suspected

Twice earlier this session, features confirmed correctly built went missing on the live site shortly after delivery. Re-confirming the delivered index.html genuinely had the features (it did, both times) and re-deploying resolved the immediate symptom, but the root cause was never conclusively identified at the time. §2 has now directly confirmed this exact failure mode is real — the live server's server.js had genuinely diverged from GitHub without anyone noticing. It's reasonable to treat that as the likely (though not separately re-verified) explanation for the index.html incidents too, and — more usefully going forward — as a standing risk for this project generally: always check the live file directly when something that should work doesn't, rather than assuming the repo is current.

10. What would help most from Claude Code
DONE (2026-08-16): got a direct answer from the project owner on the sheets.js question (§7) — confirmed cleanup candidate, deliberately deferred to a future session, not acted on tonight.
BLOCKED, not forgotten (2026-08-16): the cross-instance isolation smoke test with Kieran's server — an obviously fake test account logged on one instance, confirmed to never appear on the other, in either direction. Blocked specifically on Kieran's DO server not being live yet, not on a decision or missing plan. The plan itself is agreed: once his server is up, the owner will come back with (1) Kieran's DO server IP/port + whether to hit his API directly or go through his Netlify site's ledger function, (2) the LEDGER_API_KEY to use for each instance, (3) confirmation of the exact test steps — create an obviously-fake account (e.g. `ISOLATION-TEST-DO-NOT-USE`) on one instance via the API, confirm it's absent from the other's `/api/ledger/accounts`, repeat in reverse, then delete both test accounts. Do not create test data on either live system without that go-ahead.
Consider whether the pattern found in §2/§9 (live server quietly diverging from the committed repo) is worth guarding against going forward — e.g. a periodic reminder to diff live files against the repo, rather than relying on remembering to commit every direct server-side edit.

11. Second pattern of the same failure mode, found and fixed (2026-08-16 session)

Re-auditing §3/§6/§8's claims directly against the repo (not just trusting the write-up) turned up two more "looked done, wasn't actually committed" gaps, same shape as §2/§9:
- ledger.js/fixtures.js DO_HOST env-var fallback (§3/§6 claimed done) — was never actually in the repo; both files still had `178.128.40.248` hardcoded. Fixed and pushed this session (commit 877d9bb): both now read `LEDGER_DO_HOST`/`LEDGER_DO_PORT` env vars, falling back to the hardcoded value if unset.
- fixtures.js "FotMob leagues now DB-driven" (§6/§8 claimed done) — the DB table, CRUD routes, and "Edit Leagues" UI all genuinely existed and worked for storage, but fixtures.js itself (the function that actually serves Today's Matches) was never wired up to read from that table — it still filtered against the old hardcoded 10-league array, so editing leagues via the UI silently did nothing. Fixed in the same commit: fixtures.js now fetches the league list from `/api/ledger/fotmob-leagues` on every request, falling back to the old hardcoded list only if the DO server/`LEDGER_API_KEY` is unreachable.

Both are now genuinely fixed and pushed to `main` (877d9bb), not just diagnosed. Worth treating this as further evidence for the §9/§10 concern generally — verify "done" claims against the actual repo/live files rather than trusting a prior write-up, this project has now demonstrated the gap twice.
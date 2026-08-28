// Server-side "Lineups Confirmed" notifier.
//
// Every ~2 minutes: pull today's fixtures for the configured FotMob leagues (same handler
// Today's Matches uses), and for any match that's about to kick off and hasn't been alerted
// yet, check its FotMob lineup. The first time a match's lineup flips from predicted to
// confirmed, write a "<Home> vs <Away> — Lineups Confirmed" row into the notifications feed
// that the header bell polls. lineup_notify_state dedupes so a match only ever alerts once.
//
// Deliberately narrow: only matches kicking off in the next ~2.5h (and not long finished)
// are checked, so each tick makes at most a handful of FotMob calls.

const db = require('./ledger-db');
const fixturesHandler = require('./netlify/functions/fixtures').handler;
const lineupsHandler  = require('./netlify/functions/lineups').handler;

const TICK_MS = 120000;          // 2 minutes
const FIRST_RUN_DELAY_MS = 15000;
const LOOKAHEAD_MS = 150 * 60 * 1000;   // check matches kicking off within the next 2.5h
const LOOKBACK_MS = 20 * 60 * 1000;     // ...and up to 20 min after kickoff (late confirmations)

// FotMob's matches feed is keyed by a yyyymmdd date in Europe/London — mirror fixtures.js's
// own default, but pinned to London so a post-midnight-UTC tick still asks for "today".
function londonDateStr(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  return `${parts.year}${parts.month}${parts.day}`;
}

async function invoke(handler, queryStringParameters) {
  const result = await handler({ httpMethod: 'GET', queryStringParameters });
  try { return JSON.parse(result.body); } catch (e) { return { ok: false, error: 'bad JSON from handler' }; }
}

const alreadyNotified = db.prepare(`SELECT 1 FROM lineup_notify_state WHERE match_id = ?`);
const markNotified = db.prepare(`INSERT OR IGNORE INTO lineup_notify_state (match_id) VALUES (?)`);
const insertNotification = db.prepare(
  `INSERT INTO notifications (type, audience, title, body, meta) VALUES ('lineup', 'all', ?, NULL, ?)`
);
const prune = db.transaction(() => {
  db.prepare(`DELETE FROM notifications WHERE created_at < datetime('now', '-24 hours')`).run();
  db.prepare(`DELETE FROM lineup_notify_state WHERE notified_at < datetime('now', '-24 hours')`).run();
});

async function tick() {
  try {
    const fx = await invoke(fixturesHandler, { date: londonDateStr() });
    if (!fx.ok || !Array.isArray(fx.leagues)) { prune(); return; }

    const now = Date.now();
    const candidates = [];
    for (const league of fx.leagues) {
      for (const m of (league.matches || [])) {
        if (!m.id || m.finished) continue;
        if (alreadyNotified.get(String(m.id))) continue;
        const ko = m.utcTime ? new Date(m.utcTime).getTime() : null;
        if (ko == null || Number.isNaN(ko)) continue;
        if (ko - now > LOOKAHEAD_MS) continue;       // too far out
        if (now - ko > LOOKBACK_MS) continue;        // kicked off a while ago
        candidates.push(m);
      }
    }

    for (const m of candidates) {
      const lu = await invoke(lineupsHandler, { matchId: String(m.id) });
      if (lu && lu.ok && lu.confirmed) {
        const title = `${m.home} vs ${m.away} — Lineups Confirmed`;
        const emit = db.transaction(() => {
          insertNotification.run(title, JSON.stringify({ matchId: m.id }));
          markNotified.run(String(m.id));
        });
        emit();
        console.log('[notify] ' + title);
      }
    }
    prune();
  } catch (err) {
    console.error('[notify] tick failed:', err && err.message);
  }
}

function startLineupNotifier() {
  setTimeout(tick, FIRST_RUN_DELAY_MS);
  setInterval(tick, TICK_MS);
  console.log('[notify] lineup notifier started');
}

module.exports = { startLineupNotifier };

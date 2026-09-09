// freeze-eligible-parser.js — parses a raw copy/paste of SkyBet's Acca Freeze coupon page
// (VA-pasted a couple of times a day; see index.html's Freeze Builder paste box) into a flat
// team list. Every match on that coupon is Acca-Freeze eligible by definition — confirmed with
// the user 2026-09-09 — so nothing here filters for eligibility, it's just parsing + shaping.
//
// Observed raw-paste shape (blank lines are the only separators that matter; a competition
// header appears once, right before the first match of that competition, and stays in force
// until the next header):
//   <CompetitionName>          (only when it changes)
//   Home
//   Draw
//   Away
//   Stats
//   <HomeTeam>
//
//   <AwayTeam>
//
//   Today            (or "10 Sept" — no year)
//   19:45
//
//   11/4             (fractional odds — home, draw, away, one per blank-separated line)
//
//   12/5
//
//   1/1
//
// Strategy: collapse to a flat list of non-empty trimmed lines (blank lines carry no signal
// once removed — "Today"/time and the "Home"/"Draw"/"Away"/"Stats" header words are the only
// places two content lines are adjacent with no blank between them, which is exactly how a
// 5-line header block and a 7-line match block are told apart while walking the list).

const FRAC_RE = /^\d+\/\d+$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;
const TODAY_RE = /^today$/i;
const DATE_RE = /^(\d{1,2})\s+([A-Za-z]{3,})$/; // "10 Sept"
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

function fracToDecimal(frac) {
  const m = /^(\d+)\/(\d+)$/.exec(frac);
  if (!m) return null;
  return +(1 + (+m[1] / +m[2])).toFixed(3);
}

// Convert a UK-local wall-clock date+time to a UTC ISO string, correctly handling the
// BST/GMT boundary (SkyBet always shows local UK time) without hardcoding either offset.
function londonWallClockToUtcIso(y, monthIdx, day, hh, mm) {
  const naive = new Date(Date.UTC(y, monthIdx, day, hh, mm, 0)); // right numbers, wrong (UTC) zone
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/London', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = fmt.formatToParts(naive).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
  const asIfLondon = Date.UTC(+p.year, +p.month - 1, +p.day, p.hour === '24' ? 0 : +p.hour, +p.minute, +p.second);
  const offsetMs = naive.getTime() - asIfLondon; // how far naive (UTC) is from what London's clock actually reads
  return new Date(naive.getTime() + offsetMs).toISOString();
}

function resolveKickoff(dateLabel, timeLabel, now) {
  const [hh, mm] = timeLabel.split(':').map(Number);
  let y = now.getFullYear(), monthIdx, day;
  if (TODAY_RE.test(dateLabel)) {
    monthIdx = now.getMonth(); day = now.getDate();
  } else {
    const m = DATE_RE.exec(dateLabel);
    if (!m) return null;
    day = +m[1];
    const mi = MONTHS[m[2].slice(0, 4).toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mi == null) return null;
    monthIdx = mi;
  }
  let iso = londonWallClockToUtcIso(y, monthIdx, day, hh, mm);
  // "10 Sept" with no year: if that lands more than a day in the past relative to `now`,
  // it must mean next year (paste rolling over a year boundary, e.g. "2 Jan" pasted in December).
  if (Date.parse(iso) < now.getTime() - 24 * 3600e3) {
    iso = londonWallClockToUtcIso(y + 1, monthIdx, day, hh, mm);
  }
  return iso;
}

function parseFreezeEligibleText(rawText, opts = {}) {
  const now = opts.now || new Date();
  const lines = String(rawText || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const teams = [];
  const warnings = [];
  let competition = '';
  let i = 0;
  while (i < lines.length) {
    // Competition header: 5 lines, the next 4 after this one literally "Home","Draw","Away","Stats".
    if (
      lines[i + 1] === 'Home' && lines[i + 2] === 'Draw' &&
      lines[i + 3] === 'Away' && lines[i + 4] === 'Stats'
    ) {
      competition = lines[i];
      i += 5;
      continue;
    }
    // Otherwise expect a 7-line match block.
    if (i + 6 >= lines.length) { warnings.push(`Trailing unparsed line(s) at end of paste: ${lines.slice(i).join(' | ')}`); break; }
    const [home, away, dateLabel, timeLabel, homeFrac, drawFrac, awayFrac] = lines.slice(i, i + 7);
    const dateOk = TODAY_RE.test(dateLabel) || DATE_RE.test(dateLabel);
    const oddsOk = FRAC_RE.test(homeFrac) && FRAC_RE.test(drawFrac) && FRAC_RE.test(awayFrac);
    if (!dateOk || !TIME_RE.test(timeLabel) || !oddsOk) {
      warnings.push(`Couldn't parse a match block starting at "${home}" — skipped from here to re-sync isn't safe, stopping. ` +
        `Got: [${lines.slice(i, i + 7).join(' | ')}]`);
      break;
    }
    const kickoff = resolveKickoff(dateLabel, timeLabel, now);
    teams.push({
      home, away, competition,
      kickoff,
      homeOdds: fracToDecimal(homeFrac), drawOdds: fracToDecimal(drawFrac), awayOdds: fracToDecimal(awayFrac),
      homeFrac, drawFrac, awayFrac,
    });
    i += 7;
  }

  return { teams, warnings };
}

module.exports = { parseFreezeEligibleText, fracToDecimal, londonWallClockToUtcIso };

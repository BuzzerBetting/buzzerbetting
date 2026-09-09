// team-name-match.js — fuzzy football team-name equality, shared by skybet-bfex-lib.js and
// oddsmonkey-lib.js (kept standalone, not required from either of them, to avoid a circular
// require between the two SkyBet-odds sources).
function norm(n) {
  return (n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\butd\b/g, 'united').replace(/\bnottm\b/g, 'nottingham')
    .replace(/\bwolves\b/g, 'wolverhampton').replace(/\bspurs\b/g, 'tottenham')
    .replace(/\bmunich\b/g, 'munchen')
    .replace(/\b(fc|afc|cf|sc|ss|as|ac|sv|bk|if|fk|club|w|res)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function teamEq(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = na.split(' ').filter(w => w.length > 2), wb = nb.split(' ').filter(w => w.length > 2);
  if (!wa.length || !wb.length) return false;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (short.length === 1) return short[0] === long[0];
  return short.every(w => long.join(' ').includes(w)) || long.every(w => short.join(' ').includes(w));
}
module.exports = { norm, teamEq };

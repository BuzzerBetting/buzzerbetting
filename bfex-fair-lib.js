// bfex-fair-lib.js — the Betfair Exchange fair for one runner, shared by netlify/functions/
// betfair-f1.js and betfair-nfl-td.js (2026-10-03). User-specified method: "cut the midpoint —
// we look at last price traded, total amounts traded at which odds, the back and lay spread".
// Same approach as football's deriveBfexFair (index.html) / derive_bfex_fair (oc-scraper
// bfex_fair.py), never a back/lay midpoint, plus a check on WHERE the money actually traded:
//   1. liquidity  — >= MIN_RUNNER_TRADED matched on this runner, and a two-sided book with
//                   >= MIN_SIZE on the best back and best lay;
//   2. spread     — (lay - back) / LTP <= MAX_SPREAD_PCT;
//   3. moved out  — if the best back has drifted ABOVE LTP with >= MOVED_BACK_SIZE on it, the
//                   market has moved and that back price is the fair (as deriveBfexFair does);
//   4. anchor     — otherwise fair = last price traded, which must sit inside the live
//                   back/lay; a print the market has since moved past is stale -> no fair;
//   5. volume     — >= MIN_VOLUME_NEAR_LTP traded within +-NEAR_LTP_PCT of LTP (Betfair's
//                   per-price tradedVolume ladder, needs EX_TRADED), so one small print can't
//                   set the fair.
// Anything failing returns null — no fair, no bet. History: a back/lay midpoint (with a
// one-sided fallback, then a 50% spread allowance) priced Hadjar F1 Top 6 at 1.02 and Piastri
// at 2.12 against a 2.30/2.50 book with LTP 2.48.
const MIN_SIZE = 10;              // £ on each of the best back / best lay
const MAX_SPREAD_PCT = 0.15;      // same 15% as football
const MIN_RUNNER_TRADED = 100;    // £ matched on the runner
const NEAR_LTP_PCT = 0.05;
const MIN_VOLUME_NEAR_LTP = 50;   // £ traded within +-5% of LTP
const MOVED_BACK_SIZE = 100;      // £ on a best back above LTP before it replaces LTP

function fairFromRunner({ b, bSize, l, lSize, ltp, runnerTraded, ladder }) {
  if (!(runnerTraded >= MIN_RUNNER_TRADED) || !(ltp > 1)) return null;
  if (!(b > 1 && bSize >= MIN_SIZE && l > 1 && lSize >= MIN_SIZE)) return null;
  if ((l - b) / ltp > MAX_SPREAD_PCT) return null;
  if (b > ltp && bSize >= MOVED_BACK_SIZE) return +b.toFixed(3);
  if (ltp < b || ltp > l) return null;
  const nearVol = (ladder || []).reduce((sum, t) =>
    sum + (Math.abs((t.price || 0) - ltp) / ltp <= NEAR_LTP_PCT ? (t.size || 0) : 0), 0);
  if (nearVol < MIN_VOLUME_NEAR_LTP) return null;
  return +ltp.toFixed(3);
}

// Pulls the inputs out of a Betfair listMarketBook runner (priceProjection EX_BEST_OFFERS +
// EX_TRADED) and returns them alongside the fair, so callers can still report back/lay/sizes.
function runnerFair(r) {
  const ex = (r && r.ex) || {};
  const back = ex.availableToBack && ex.availableToBack[0];
  const lay = ex.availableToLay && ex.availableToLay[0];
  const b = (back && back.price) || 0, bSize = (back && back.size) || 0;
  const l = (lay && lay.price) || 0, lSize = (lay && lay.size) || 0;
  const ladder = ex.tradedVolume || [];
  const runnerTraded = (r && r.totalMatched) || ladder.reduce((sum, t) => sum + (t.size || 0), 0);
  const ltp = (r && r.lastPriceTraded) || 0;
  return { b, bSize, l, lSize, ltp, runnerTraded, ladder, fair: fairFromRunner({ b, bSize, l, lSize, ltp, runnerTraded, ladder }) };
}

module.exports = { fairFromRunner, runnerFair };

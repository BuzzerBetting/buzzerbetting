// Shared circuit-breaker + pacer for all SkyBet traffic (skybet.com pages AND the
// apitbd.skybet.com GraphQL BFF). SkyBet hard-bans a datacentre IP that bursts it:
// HTTP 429 with body {"error":"enhance_your_calm"} and a Retry-After measured in
// HOURS. Both skybet-bfex-lib.js and skybet-accafreeze-lib.js route their fetches
// through here so a single 429 pauses EVERY SkyBet request from this process until
// the ban lifts — instead of the cache warmer, the builder and the accafreeze
// scraper each independently re-arming it every few minutes.
//
// Usage:  await skyThrottle();  const res = await fetch(url, opts);  noteResponse(res);
// skyThrottle() throws an Error with .code === 'SKY_BLOCKED' while the circuit is open.

let blockedUntil = 0;
let lastCallAt = 0;

const MIN_GAP_MS = 350;                 // min spacing between any two SkyBet requests
const DEFAULT_BACKOFF_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 2 * 60 * 60 * 1000; // cap: probe again after 2h even if Retry-After says longer

function blockedForMs() { return Math.max(0, blockedUntil - Date.now()); }
function isBlocked() { return Date.now() < blockedUntil; }

async function skyThrottle() {
  if (isBlocked()) {
    const e = new Error(`SkyBet circuit open — ${Math.round(blockedForMs() / 1000)}s left`);
    e.code = 'SKY_BLOCKED';
    throw e;
  }
  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

// Feed every SkyBet Response through here. A 429/503 opens the circuit.
function noteResponse(res) {
  if (!res || (res.status !== 429 && res.status !== 503)) return;
  let backoff = DEFAULT_BACKOFF_MS;
  const ra = parseInt((res.headers && res.headers.get && res.headers.get('retry-after')) || '', 10);
  if (Number.isFinite(ra) && ra > 0) backoff = Math.min(ra * 1000, MAX_BACKOFF_MS);
  const until = Date.now() + backoff;
  if (until > blockedUntil) {
    blockedUntil = until;
    console.log(`[sky-throttle] HTTP ${res.status} from SkyBet — pausing all SkyBet traffic for ${Math.round(backoff / 1000)}s`);
  }
}

module.exports = { skyThrottle, noteResponse, isBlocked, blockedForMs };

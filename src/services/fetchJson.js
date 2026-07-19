'use strict';

// Fetch JSON with retry on transient upstream failures.
//
// The Blockscout explorer (used for holder snapshots) sits behind Cloudflare and
// intermittently returns 520/5xx/429 — a single blip must not fail a whole cycle
// (cycle 19 bought PONS, then a lone 520 on the holder fetch failed the cycle and
// stranded the PONS). We retry those with backoff; genuinely non-retryable
// responses (e.g. 404) and network errors past the retry budget still throw.

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET `url` and parse JSON, retrying transient failures.
 * @param {string} url
 * @param {{headers?: object, retries?: number, delayMs?: number,
 *          sleepFn?: (ms:number)=>Promise<void>, fetchFn?: typeof fetch}} [opts]
 */
async function fetchJson(url, { headers, retries = 4, delayMs = 1500, sleepFn = sleep, fetchFn = fetch } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let res;
    try {
      res = await fetchFn(url, { headers });
    } catch (err) {
      // Network / DNS / socket error — retryable.
      lastErr = err;
      if (attempt === retries) throw err;
      await sleepFn(delayMs);
      continue;
    }

    if (res.ok) return res.json();

    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    if (!RETRYABLE_STATUS.has(res.status) || attempt === retries) throw err;
    lastErr = err;
    await sleepFn(delayMs);
  }
  throw lastErr; // unreachable (loop returns or throws), kept for clarity
}

module.exports = { fetchJson, RETRYABLE_STATUS };

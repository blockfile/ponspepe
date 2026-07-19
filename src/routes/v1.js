'use strict';

// Versioned public API for the Robinhood Index Fund site. Read-only, cached, and
// shaped so the frontend consumes it directly. Live prices/market data are read
// on demand behind the cache, so these endpoints are cheap to poll.

const express = require('express');
const { buildStats, buildStocks, buildAccrual, buildDistributions } = require('../services/v1');

const router = express.Router();

// Tiny TTL cache — the site polls these, so de-dupe and rate-limit the on-chain
// + DexScreener reads that back them.
function cached(ttlMs, fn) {
  let value;
  let expires = 0;
  let inflight = null;
  return async () => {
    if (Date.now() < expires) return value;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        value = await fn();
        expires = Date.now() + ttlMs;
        return value;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

const loadStats = cached(15_000, buildStats);
const loadStocks = cached(30_000, buildStocks);
// The progress bar has to move, so accrual gets its own short TTL instead of
// riding the 15s stats cache. Backed by one shared RPC read, so polling this
// often costs the same no matter how many visitors are watching.
const loadAccrual = cached(5_000, buildAccrual);
// Per-wallet drops, so keep a deeper window than the old per-cycle receipts.
const loadDistributions = cached(10_000, () => buildDistributions(50));

// Accrual is merged in so the site's progress bar can read it straight off
// /v1/stats, while the heavy market-data + DB aggregates stay on the long cache.
router.get('/stats', async (req, res, next) => {
  try {
    const [stats, accrual] = await Promise.all([loadStats(), loadAccrual()]);
    res.json({ ...stats, ...accrual });
  } catch (err) {
    next(err);
  }
});

// Lightweight sibling for fast polling: just the progress-bar fields, no
// market-data or DB work.
router.get('/accrual', async (req, res, next) => {
  try {
    res.json(await loadAccrual());
  } catch (err) {
    next(err);
  }
});

router.get('/stocks', async (req, res, next) => {
  try {
    res.json(await loadStocks());
  } catch (err) {
    next(err);
  }
});

router.get('/distributions', async (req, res, next) => {
  try {
    res.json(await loadDistributions());
  } catch (err) {
    next(err);
  }
});

module.exports = router;

'use strict';

// Versioned public API for the Robinhood Index Fund site. Read-only, cached, and
// shaped so the frontend consumes it directly. Live prices/market data are read
// on demand behind the cache, so these endpoints are cheap to poll.

const express = require('express');
const { buildStats, buildStocks, buildDistributions } = require('../services/v1');

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
// Per-wallet drops, so keep a deeper window than the old per-cycle receipts.
const loadDistributions = cached(10_000, () => buildDistributions(50));

router.get('/stats', async (req, res, next) => {
  try {
    res.json(await loadStats());
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

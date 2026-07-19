'use strict';

// Shared, cached read of the live unclaimed creator-fee balance so /api/unclaimed
// and /api/status don't each hit the RPC on every request.
const { getClaimableEth } = require('../evm/pons');

let cache = { value: null, at: 0 };
// 5s: the site's "next drop" progress bar polls this, so the number has to move
// often enough to look live. The cache is process-wide, so the RPC cost is fixed
// (~12 reads/min) no matter how many visitors are polling.
const TTL_MS = 5_000;

async function getUnclaimedEth() {
  const now = Date.now();
  if (cache.value !== null && now - cache.at < TTL_MS) {
    return { eth: cache.value, at: cache.at, fresh: false };
  }
  const eth = await getClaimableEth();
  cache = { value: eth, at: now };
  return { eth, at: now, fresh: true };
}

module.exports = { getUnclaimedEth };

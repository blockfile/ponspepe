'use strict';

// The /v1 API — the shapes the frontend renders. The reward is now a SINGLE token
// (PONS) bought with the WETH claim on Uniswap V3 and airdropped to the ponspepe
// holders. Live PONS USD pricing is not wired in this pass, so USD-valued fields
// are null (the honest value until a price feed is added).

const config = require('../config');
const repo = require('../db/repository');
const { getMarketData } = require('./marketdata');
const { nextRun } = require('./countdown');
const { sumAirdrops } = require('./format');

// reward_token address (lowercased) -> symbol.
const SYMBOL_BY_ADDR = { [config.rewardToken.toLowerCase()]: config.rewardSymbol };

/**
 * GET /v1/stocks — the reward constituent(s). One token now: PONS.
 * `distributed` is the all-time UI amount of the reward airdropped, which the
 * site renders on the holdings card.
 */
async function buildStocks() {
  const totals = await repo.getAirdropTotals().catch(() => ({}));
  const mine = totals[config.rewardToken] || totals[config.rewardToken.toLowerCase()] || {};
  return [
    {
      symbol: config.rewardSymbol,
      name: config.rewardSymbol,
      address: config.rewardToken,
      priceUsd: null, // no live PONS USD feed wired in this pass
      distributed: +(mine.totalUi || 0).toFixed(6),
    },
  ];
}

/** GET /v1/stats — protocol overview. */
async function buildStats() {
  const [stats, market, airdropTotals, eligibleNow] = await Promise.all([
    repo.getStats(),
    getMarketData().catch(() => ({ marketCap: null, priceUsd: null })),
    repo.getAirdropTotals().catch(() => ({})),
    repo.getLatestEligibleHolders().catch(() => null),
  ]);

  const { nextAirdropAt, intervalSec } = nextRun(config.pollSchedule, Date.now());
  // CURRENT eligible wallets = the last cycle's fresh snapshot (>= MIN_HOLD, minus
  // exclusions). This drops as wallets become ineligible — unlike the all-time
  // count of everyone ever paid, which only grows. Fall back to that all-time
  // count only before the first cycle has snapshotted.
  const walletsPaidAllTime = sumAirdrops(airdropTotals).rewardHolders;
  const eligible = eligibleNow != null ? eligibleNow : walletsPaidAllTime;

  return {
    ticker: config.tokenSymbol,
    contractAddress: config.tokenAddress,
    marketCapUsd: market.marketCap ?? null, // null until the token is listed on DexScreener
    indexPriceUsd: market.priceUsd ?? null, // null until listed
    totalValueDistributedUsd: null, // no live PONS USD price wired in this pass
    feesCollectedEth: +(stats.total_eth_claimed || 0).toFixed(6),
    // The token-side fee is burned in FULL each cycle (never sold/transferred).
    // Three names for the same number — the site reads `ponsBurned`/`tokensBurned`.
    ponspepeBurned: stats.total_tokens_burned || 0,
    ponsBurned: stats.total_tokens_burned || 0,
    tokensBurned: stats.total_tokens_burned || 0,
    // Retained for backwards compatibility; always 0 now that nothing is sold.
    ponspepeSold: stats.total_tokens_sold || 0,
    ethToDev: +(stats.total_eth_to_dev || 0).toFixed(6),
    devFees: stats.devFees || 0,
    burns: stats.burns || 0,
    wallets: eligible, // CURRENT eligible wallets (last cycle's snapshot)
    holders: eligible,
    walletsPaidAllTime, // distinct wallets ever airdropped (cumulative)
    distributionIntervalSeconds: intervalSec,
    nextDistributionAt: nextAirdropAt,
    feePercent: 1,
    eligibilityThreshold: config.minHold,
  };
}

/**
 * One `airdrops` row → the PER-WALLET drop the site's live feed renders.
 * `id` keeps a numeric tail so the frontend can poll for "newer than <id>".
 */
function airdropToDrop(a) {
  return {
    id: `drop-${a.id}`,
    wallet: a.recipient,
    pons: Number(a.amount_ui) || 0, // reward received by this wallet
    txHash: a.signature ?? null,
    timestamp: Date.parse(a.created_at) || Date.now(), // epoch ms
  };
}

/**
 * GET /v1/distributions — recent PER-WALLET reward drops, newest first.
 * One row per wallet paid (not per cycle), which is what the live feed renders.
 */
async function buildDistributions(limit = 50) {
  const { items } = await repo.getAirdrops(limit, 0, config.rewardToken);
  return (items || []).filter((a) => a.status === 'ok').map(airdropToDrop);
}

module.exports = { buildStocks, buildStats, buildDistributions, airdropToDrop, SYMBOL_BY_ADDR };

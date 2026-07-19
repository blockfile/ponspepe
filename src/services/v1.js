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

/** GET /v1/stocks — the reward constituent(s). One token now: PONS. */
async function buildStocks() {
  return [
    { symbol: config.rewardSymbol, name: config.rewardSymbol, address: config.rewardToken, priceUsd: null },
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
    ponspepeBurned: stats.total_tokens_burned || 0, // token-side fee burned to date
    ponspepeSold: stats.total_tokens_sold || 0, // token-side fee sold to ETH for the dev (NOT burned)
    ethToDev: +(stats.total_eth_to_dev || 0).toFixed(6), // ETH sent to the dev from selling the fee
    devFees: stats.devFees || 0, // count of dev-fee sells performed
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

/** One cycle's steps → a distribution receipt, or null if it bought nothing. */
function cycleToDistribution(cycle) {
  const steps = cycle.steps || [];
  const buys = steps.filter((s) => s.name === 'buy' && s.detail && s.detail.leg === 'reward' && s.status === 'ok');
  if (!buys.length) return null;

  const allocations = buys.map((s) => ({
    symbol: s.detail.symbol,
    shares: Number(s.detail.tokensBought) || 0,
    usd: null, // no live PONS USD price wired in this pass
  }));
  const airdrop = steps.find((s) => s.name === 'airdrop');

  return {
    id: `dist-${cycle.id}`,
    timestamp: Date.parse(cycle.finished_at || cycle.started_at) || Date.now(),
    wallets: cycle.eligible_holders ?? (airdrop && airdrop.detail ? airdrop.detail.sent : 0) ?? 0,
    txHash: steps.map((s) => s.signature).find(Boolean) ?? null,
    allocations,
  };
}

/** GET /v1/distributions — recent distribution receipts, newest first. */
async function buildDistributions(limit = 12) {
  const { items } = await repo.getCycles(limit, 0);
  const complete = items.filter((c) => c.status === 'complete');
  const full = await Promise.all(complete.map((c) => repo.getCycleWithSteps(c.id)));
  return full
    .filter(Boolean)
    .map((c) => cycleToDistribution(c))
    .filter(Boolean);
}

module.exports = { buildStocks, buildStats, buildDistributions, cycleToDistribution, SYMBOL_BY_ADDR };

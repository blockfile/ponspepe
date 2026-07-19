'use strict';

// The /v1 API — the shapes the frontend renders. The reward is a SINGLE token
// (PONS) bought with the WETH claim on Uniswap V3 and airdropped to the ponspepe
// holders. PONS is priced from its deepest DexScreener pool, so USD-valued
// fields are real; they stay null (never 0) when PONS can't be priced, so the
// site can tell "nothing yet" apart from "we couldn't price it".

const config = require('../config');
const repo = require('../db/repository');
const { getMarketData, getTokenMarketData } = require('./marketdata');
const { getUnclaimedEth } = require('./metrics');
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
  const [totals, rewardMarket] = await Promise.all([
    repo.getAirdropTotals().catch(() => ({})),
    getTokenMarketData(config.rewardToken).catch(() => ({ priceUsd: null })),
  ]);
  const mine = totals[config.rewardToken] || totals[config.rewardToken.toLowerCase()] || {};
  return [
    {
      symbol: config.rewardSymbol,
      name: config.rewardSymbol,
      address: config.rewardToken,
      priceUsd: rewardMarket && rewardMarket.priceUsd != null ? rewardMarket.priceUsd : null,
      distributed: +(mine.totalUi || 0).toFixed(6),
    },
  ];
}

/** GET /v1/stats — protocol overview. */
async function buildStats() {
  const [stats, market, rewardMarket, airdropTotals, eligibleNow] = await Promise.all([
    repo.getStats(),
    getMarketData().catch(() => ({ marketCap: null, priceUsd: null })),
    getTokenMarketData(config.rewardToken).catch(() => ({ priceUsd: null })),
    repo.getAirdropTotals().catch(() => ({})),
    repo.getLatestEligibleHolders().catch(() => null),
  ]);

  const { nextAirdropAt, intervalSec } = nextRun(config.pollSchedule, Date.now());

  // USD value of everything airdropped = PONS distributed x its live price.
  // Stays null (never 0) when PONS can't be priced, so "nothing distributed yet"
  // is distinguishable from "we couldn't reach the price feed".
  const air = sumAirdrops(airdropTotals);
  const rewardPriceUsd = rewardMarket && rewardMarket.priceUsd != null ? rewardMarket.priceUsd : null;
  const totalValueDistributedUsd =
    rewardPriceUsd != null ? +(air.rewardsDistributed * rewardPriceUsd).toFixed(2) : null;
  // CURRENT eligible wallets = the last cycle's fresh snapshot (>= MIN_HOLD, minus
  // exclusions). This drops as wallets become ineligible — unlike the all-time
  // count of everyone ever paid, which only grows. Fall back to that all-time
  // count only before the first cycle has snapshotted.
  const walletsPaidAllTime = air.rewardHolders;
  const eligible = eligibleNow != null ? eligibleNow : walletsPaidAllTime;

  return {
    ticker: config.tokenSymbol,
    contractAddress: config.tokenAddress,
    marketCapUsd: market.marketCap ?? null, // null until the token is listed on DexScreener
    indexPriceUsd: market.priceUsd ?? null, // null until listed
    totalValueDistributedUsd, // PONS airdropped x live PONS price (null if unpriced)
    rewardsDistributed: air.rewardsDistributed, // PONS airdropped to date (token count)
    rewardPriceUsd, // live PONS price in USD (null when unlisted/unreachable)
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
 * The "next drop" progress bar: creator fees pending right now vs the threshold
 * that fires a cycle. Split out from buildStats so it can be cached on a much
 * shorter TTL — the bar has to move, while market cap and DB aggregates don't.
 * The underlying RPC read is shared and cached in services/metrics.
 */
async function buildAccrual() {
  const { eth } = await getUnclaimedEth().catch(() => ({ eth: null }));
  // In 'interval' mode any claimable amount fires a cycle, so there is no target
  // to fill toward: report 0 and let the site hide the bar.
  const target = config.triggerMode === 'accumulation' ? config.claimEveryEth : 0;
  const accrued = eth == null ? null : +eth.toFixed(9);
  const pct =
    accrued != null && target > 0 ? Math.min(100, +((accrued / target) * 100).toFixed(2)) : null;

  return {
    feesAccruedEth: accrued, // ETH pending now; falls back to ~0 after a claim
    feesTargetEth: target, // ETH threshold that triggers a cycle
    feesProgressPct: pct, // 0-100, clamped — the bar fill
    triggerMode: config.triggerMode,
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

module.exports = { buildStocks, buildStats, buildAccrual, buildDistributions, airdropToDrop, SYMBOL_BY_ADDR };

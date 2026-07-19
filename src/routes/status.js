'use strict';

const express = require('express');
const { formatEther } = require('ethers');
const config = require('../config');
const repo = require('../db/repository');
const scheduler = require('../jobs/scheduler');
const { provider, wallet, walletAddress } = require('../evm/provider');
const { getUnclaimedEth } = require('../services/metrics');
const { getEthPriceUsd, toUsd } = require('../evm/price');
const { sumAirdrops } = require('../services/format');

const router = express.Router();

const TOKEN_SYMBOL = config.tokenSymbol;

// GET /api/status — everything the dashboard needs: cards, totals (with USD),
// live unclaimed fees, scheduler state, and the last cycle.
router.get('/status', async (req, res, next) => {
  try {
    const [stats, lastCycle, unclaimed, price, airdropTotals] = await Promise.all([
      repo.getStats(),
      repo.getLastCycle(),
      getUnclaimedEth().catch(() => ({ eth: null, at: Date.now() })),
      getEthPriceUsd(),
      repo.getAirdropTotals().catch(() => ({})),
    ]);
    const air = sumAirdrops(airdropTotals);

    let ethBalance = null;
    let balanceSource = 'none';
    if (!config.dryRun) {
      try {
        const wei = await provider.getBalance(wallet.address);
        ethBalance = Number(formatEther(wei));
        balanceSource = 'rpc';
      } catch (err) {
        balanceSource = `rpc_error: ${err.message}`;
      }
    }

    res.json({
      dryRun: config.dryRun,
      tokenSymbol: TOKEN_SYMBOL,
      rewardSymbol: config.rewardSymbol,
      chainId: config.chainId,
      ethPriceUsd: price,

      // top cards
      cards: {
        unclaimedEth: unclaimed.eth == null ? null : +unclaimed.eth.toFixed(9),
        unclaimedUsd: toUsd(unclaimed.eth, price),
        totalClaimedEth: stats.total_eth_claimed,
        totalClaimedUsd: toUsd(stats.total_eth_claimed, price),
        rewardsDistributed: air.rewardsDistributed,
        rewardHolders: air.rewardHolders,
      },

      wallet: {
        address: walletAddress(),
        ephemeral: config.walletIsEphemeral,
        ethBalance,
        balanceSource,
      },
      token: {
        address: config.tokenAddress,
        reward: config.rewardToken,
      },
      // Reward-and-burn loop parameters (trigger, split).
      config: {
        triggerMode: config.triggerMode,
        pollSchedule: config.pollSchedule,
        claimEveryEth: config.claimEveryEth,
        rewardBuyPct: config.rewardBuyPct,
        burnPct: config.burnPct,
        devPct: config.devPct,
        minHold: config.minHold,
        deadAddress: config.deadAddress,
      },
      totals: {
        cycles: stats.cycles,
        completed: stats.completed,
        failed: stats.failed,
        skipped: stats.skipped,
        ethClaimed: stats.total_eth_claimed,
        ethSpentBuying: +(stats.total_eth_spent_buy || 0).toFixed(9),
        tokensBurned: stats.total_tokens_burned || 0,
        burns: stats.burns || 0,
        rewardsDistributed: air.rewardsDistributed,
        rewardSends: air.rewardSends,
        rewardHolders: air.rewardHolders,
      },
      scheduler: scheduler.getState(),
      lastCycle,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

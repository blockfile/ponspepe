'use strict';
const test = require('node:test');
const assert = require('node:assert');

// Stub the network-backed market data BEFORE requiring v1 so buildStats stays
// offline and deterministic.
const marketdata = require('./marketdata');
marketdata.getMarketData = async () => ({ marketCap: null, priceUsd: null });
const repo = require('../db/repository');
const config = require('../config');

const { buildStats, buildStocks, cycleToDistribution, SYMBOL_BY_ADDR } = require('./v1');

const CYCLE = {
  id: 5,
  status: 'complete',
  finished_at: '2026-07-18T00:00:00.000Z',
  eligible_holders: 2466,
  steps: [
    { name: 'claim', status: 'ok', signature: '0xclaimsig', detail: { ethClaimed: 0.5 } },
    { name: 'buy', status: 'ok', signature: '0xbuysig', detail: { leg: 'reward', symbol: config.rewardSymbol, token: config.rewardToken, tokensBought: 12345 } },
    { name: 'airdrop', status: 'ok', detail: { token: config.rewardToken, sent: 2466 } },
  ],
};

test('cycleToDistribution builds a receipt from the single reward buy', () => {
  const d = cycleToDistribution(CYCLE);
  assert.strictEqual(d.id, 'dist-5');
  assert.strictEqual(d.timestamp, Date.parse('2026-07-18T00:00:00.000Z'));
  assert.strictEqual(d.wallets, 2466);
  assert.strictEqual(d.txHash, '0xclaimsig', 'first available signature');
  assert.deepStrictEqual(d.allocations, [{ symbol: config.rewardSymbol, shares: 12345, usd: null }]);
});

test('cycleToDistribution returns null for a cycle that bought nothing', () => {
  const claimOnly = { id: 9, status: 'skipped', steps: [{ name: 'claim', status: 'ok' }] };
  assert.strictEqual(cycleToDistribution(claimOnly), null);
});

test('SYMBOL_BY_ADDR maps the reward token address to its symbol', () => {
  assert.strictEqual(SYMBOL_BY_ADDR[config.rewardToken.toLowerCase()], config.rewardSymbol);
});

test('buildStocks returns the single reward token constituent', async () => {
  const stocks = await buildStocks();
  assert.strictEqual(stocks.length, 1);
  assert.strictEqual(stocks[0].symbol, config.rewardSymbol);
  assert.strictEqual(stocks[0].address, config.rewardToken);
  assert.strictEqual(stocks[0].priceUsd, null);
});

test('/v1 stats exposes ponspepeBurned/ponspepeSold, ethToDev, devFees (honest, separate from burns)', async () => {
  repo.getStats = async () => ({
    cycles: 1, completed: 1, failed: 0, skipped: 0,
    total_eth_spent_buy: 0, total_tokens_bought: 0,
    total_tokens_burned: 50, total_tokens_sold: 950, total_eth_to_dev: 0.5,
    total_eth_claimed: 0, burns: 1, devFees: 1,
  });
  repo.getAirdropTotals = async () => ({});
  repo.getLatestEligibleHolders = async () => 0;

  const stats = await buildStats();
  assert.strictEqual(stats.ponspepeBurned, 50);
  assert.strictEqual(stats.ponspepeSold, 950);
  assert.ok(Math.abs(stats.ethToDev - 0.5) < 1e-9);
  assert.strictEqual(stats.devFees, 1);
});

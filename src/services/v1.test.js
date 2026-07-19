'use strict';
const test = require('node:test');
const assert = require('node:assert');

// Stub the network-backed market data BEFORE requiring v1 so buildStats stays
// offline and deterministic.
const marketdata = require('./marketdata');
marketdata.getMarketData = async () => ({ marketCap: null, priceUsd: null });
const repo = require('../db/repository');
const config = require('../config');

const { buildStats, buildStocks, buildDistributions, airdropToDrop, SYMBOL_BY_ADDR } = require('./v1');

const AIRDROP = {
  id: 7,
  cycle_id: 5,
  reward_token: config.rewardToken,
  recipient: '0xabc0000000000000000000000000000000000001',
  amount_raw: '1000000000000000000',
  amount_ui: 12.5,
  signature: '0xdropsig',
  status: 'ok',
  created_at: '2026-07-18T00:00:00.000Z',
};

test('airdropToDrop maps an airdrop row to a per-wallet drop', () => {
  const d = airdropToDrop(AIRDROP);
  assert.strictEqual(d.id, 'drop-7', 'id keeps a numeric tail for newer-than polling');
  assert.strictEqual(d.wallet, AIRDROP.recipient);
  assert.strictEqual(d.pons, 12.5);
  assert.strictEqual(d.txHash, '0xdropsig');
  assert.strictEqual(d.timestamp, Date.parse('2026-07-18T00:00:00.000Z'));
});

test('buildDistributions returns per-wallet drops, newest first, successful only', async () => {
  repo.getAirdrops = async (limit, offset, rewardToken) => {
    assert.strictEqual(rewardToken, config.rewardToken, 'filters to the reward token');
    return {
      total: 3,
      items: [
        { ...AIRDROP, id: 9, recipient: '0xbbb', amount_ui: 3 },
        { ...AIRDROP, id: 8, status: 'failed', recipient: '0xccc', amount_ui: 99 },
        { ...AIRDROP, id: 7 },
      ],
    };
  };

  const rows = await buildDistributions(50);
  assert.strictEqual(rows.length, 2, 'failed sends are excluded');
  assert.deepStrictEqual(rows.map((r) => r.id), ['drop-9', 'drop-7'], 'newest first');
  assert.strictEqual(rows[0].wallet, '0xbbb');
  assert.strictEqual(rows[0].pons, 3);
});

test('SYMBOL_BY_ADDR maps the reward token address to its symbol', () => {
  assert.strictEqual(SYMBOL_BY_ADDR[config.rewardToken.toLowerCase()], config.rewardSymbol);
});

test('buildStocks returns the reward constituent with its all-time distributed', async () => {
  repo.getAirdropTotals = async () => ({ [config.rewardToken]: { sends: 4, totalUi: 250.5, holders: 3 } });

  const stocks = await buildStocks();
  assert.strictEqual(stocks.length, 1);
  assert.strictEqual(stocks[0].symbol, config.rewardSymbol);
  assert.strictEqual(stocks[0].address, config.rewardToken);
  assert.strictEqual(stocks[0].priceUsd, null);
  assert.strictEqual(stocks[0].distributed, 250.5);
});

test('/v1 stats exposes the burned total under every name the site reads', async () => {
  repo.getStats = async () => ({
    cycles: 1, completed: 1, failed: 0, skipped: 0,
    total_eth_spent_buy: 0, total_tokens_bought: 0,
    total_tokens_burned: 1000, total_tokens_sold: 0, total_eth_to_dev: 0,
    total_eth_claimed: 0, burns: 1, devFees: 0,
  });
  repo.getAirdropTotals = async () => ({});
  repo.getLatestEligibleHolders = async () => 42;

  const stats = await buildStats();
  // The site reads `ponsBurned ?? tokensBurned`; all three must agree.
  assert.strictEqual(stats.ponspepeBurned, 1000);
  assert.strictEqual(stats.ponsBurned, 1000);
  assert.strictEqual(stats.tokensBurned, 1000);
  // Nothing is sold any more — kept at 0 for backwards compatibility.
  assert.strictEqual(stats.ponspepeSold, 0);
  assert.strictEqual(stats.ethToDev, 0);
  // The site reads `wallets ?? holders`.
  assert.strictEqual(stats.wallets, 42);
  assert.strictEqual(stats.holders, 42);
});

'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

// One mongo server for the whole file: config.mongoUri is captured when db/index
// first loads config, so a second connect() in the same process would point at
// the first (stopped) server. Both scenarios share one connection.
let mongod;
let db;
let repo;
let simvault;
let runCycle;
let config;

before(async () => {
  process.env.DRY_RUN = 'true';
  process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000a1b69';
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'ponsliqui_test_cycle';
  delete require.cache[require.resolve('../config')];
  config = require('../config');
  db = require('../db/index');
  repo = require('../db/repository');
  simvault = require('../evm/simvault');
  ({ runCycle } = require('./cycle'));
  await db.connect();
});

after(async () => {
  await db.close();
  await mongod.stop();
  delete require.cache[require.resolve('../config')];
  delete process.env.TOKEN_ADDRESS;
});

test('runCycle (DRY_RUN): claim → burn ponspepe fee + dev-sell → buy PONS on V3 + airdrop → dev', async () => {
  simvault.reset(0.05); // creator-fee vault has fees to claim
  const cycle = await runCycle();
  assert.strictEqual(cycle.status, 'complete');
  assert.strictEqual(cycle.mode, 'pons-reward');

  // Order: claim, then burn the token-side ponspepe fee, THEN the reward buy+airdrop.
  const names = cycle.steps.map((s) => s.name);
  assert.strictEqual(names[0], 'claim');
  assert.strictEqual(names[1], 'burn', 'ponspepe fee burned right after the claim, before the buy');
  assert.ok(cycle.tokens_burned > 0, 'ponspepe fee was burned');

  // The token-side fee is SPLIT: burn 5%, sell 95% as a disclosed dev fee.
  assert.strictEqual(names[2], 'dev-fee', 'dev-fee sell recorded right after the burn');
  const devFee = cycle.steps.find((s) => s.name === 'dev-fee');
  assert.strictEqual(devFee.status, 'ok');
  assert.ok(cycle.tokens_sold > 0, 'ponspepe fee was sold, not burned');
  assert.ok(cycle.tokens_sold > cycle.tokens_burned, '95% sold vs 5% burned');
  assert.ok(cycle.eth_to_dev > 0, 'sale proceeds recorded for the dev');
  assert.strictEqual(devFee.detail.devWallet, config.wallet.address.toLowerCase());

  // Reward leg: a SINGLE PONS buy funded by the whole reward-WETH, then a SINGLE
  // airdrop of what was bought.
  const buys = cycle.steps.filter((s) => s.name === 'buy' && s.detail?.leg === 'reward');
  const drops = cycle.steps.filter((s) => s.name === 'airdrop');
  assert.strictEqual(buys.length, 1, 'one reward buy');
  assert.strictEqual(drops.length, 1, 'one reward airdrop');
  assert.strictEqual(buys.length, cycle.steps.filter((s) => s.name === 'buy').length, 'no non-reward buys');
  assert.strictEqual(buys[0].detail.symbol, config.rewardSymbol);
  assert.strictEqual(buys[0].detail.token, config.rewardToken);
  assert.strictEqual(drops[0].detail.token, config.rewardToken);

  assert.ok(cycle.eth_claimed > 0);
  // 80% of the claim funds the PONS buy (the whole reward-WETH, one buy).
  assert.ok(Math.abs(cycle.eth_spent_buy - cycle.eth_claimed * 0.8) < 1e-6, '80% spent on PONS');
  assert.ok(Math.abs(buys[0].detail.ethSpent - cycle.eth_claimed * 0.8) < 1e-6, 'the whole reward WETH funds the single buy');
  assert.ok(cycle.tokens_bought > 0, 'PONS bought recorded');

  // Two simulated eligible holders (operating wallet excluded).
  assert.strictEqual(cycle.eligible_holders, 2);
  assert.strictEqual(cycle.total_holders, 3);
  assert.strictEqual(drops[0].detail.sent, 2);
  assert.strictEqual(drops[0].detail.failed, 0);

  // Airdrop rows persisted for the single reward token: it paid both holders.
  const totals = await repo.getAirdropTotals();
  assert.strictEqual(Object.keys(totals).length, 1, 'one total — the reward token');
  const t = totals[config.rewardToken];
  assert.ok(t, 'reward token total present');
  assert.strictEqual(t.holders, 2);
  assert.strictEqual(t.sends, 2);
});

test('runCycle (DRY_RUN): nothing claimable → skipped', async () => {
  simvault.reset(0); // empty vault
  const cycle = await runCycle();
  assert.strictEqual(cycle.status, 'skipped');
  assert.ok(cycle.steps.some((s) => s.name === 'claim'));
  assert.ok(!cycle.steps.some((s) => s.name === 'buy'));
});

test('BURN_PCT=100 reproduces burn-only behavior (no dev-fee sell)', async () => {
  process.env.BURN_PCT = '100';
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../evm/sell')];
  delete require.cache[require.resolve('./cycle')];
  const { runCycle: runCycle100 } = require('./cycle');
  simvault.reset(0.05);
  const cycle = await runCycle100();
  assert.ok(cycle.steps.some((s) => s.name === 'burn'));
  assert.ok(!cycle.steps.some((s) => s.name === 'dev-fee'), 'nothing sold when BURN_PCT=100');
  assert.ok(!(cycle.tokens_sold > 0));
  delete process.env.BURN_PCT;
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../evm/sell')];
  delete require.cache[require.resolve('./cycle')];
});

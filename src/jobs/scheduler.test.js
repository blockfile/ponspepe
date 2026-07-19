'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Modules that read config at load — cleared between tests so each gets a fresh
// config (and its own mongod via a fresh db/index connect).
const CHAIN_MODULES = [
  '../config',
  '../db/index',
  '../db/repository',
  '../evm/simvault',
  '../evm/provider',
  '../evm/erc20',
  '../evm/pons',
  '../evm/holders',
  '../evm/exclude',
  '../evm/airdrop',
  '../evm/v4',
  '../evm/stocks',
  '../services/distribution',
  './cycle',
  './scheduler',
];
function clearCaches() {
  for (const m of CHAIN_MODULES) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_e) {
      /* not loaded */
    }
  }
}

async function withScheduler(env, fn) {
  const mongod = await MongoMemoryServer.create();
  Object.assign(process.env, {
    DRY_RUN: 'true',
    TOKEN_ADDRESS: '0x00000000000000000000000000000000000a1b69',
    DRY_RUN_FEE_PER_POLL: '0', // no simulated accrual — the test controls the vault
    MONGODB_URI: mongod.getUri(),
    MONGODB_DB: 'ponsliqui_test_sched',
    ...env,
  });
  clearCaches();
  const db = require('../db/index');
  const repo = require('../db/repository');
  const simvault = require('../evm/simvault');
  const scheduler = require('./scheduler');
  await db.connect();
  try {
    await fn({ repo, simvault, scheduler });
  } finally {
    await db.close();
    await mongod.stop();
    delete process.env.TRIGGER_MODE;
    delete process.env.CLAIM_EVERY_ETH;
    clearCaches();
  }
}

test('interval mode: skips when empty, runs on any claimable', async () => {
  await withScheduler({ TRIGGER_MODE: 'interval' }, async ({ repo, simvault, scheduler }) => {
    simvault.reset(0);
    const p1 = await scheduler.pollOnce('poll');
    assert.strictEqual(p1.ran, false);
    assert.strictEqual(p1.reason, 'nothing claimable');
    assert.strictEqual((await repo.getCycles(10, 0)).total, 0);

    simvault.reset(0.001); // any amount at all
    const p2 = await scheduler.pollOnce('poll');
    assert.strictEqual(p2.ran, true);
    assert.strictEqual(p2.cycle.status, 'complete');
    assert.strictEqual((await repo.getCycles(10, 0)).total, 1);
  });
});

test('accumulation mode: holds below CLAIM_EVERY_ETH, runs at/above', async () => {
  await withScheduler({ TRIGGER_MODE: 'accumulation', CLAIM_EVERY_ETH: '0.015' }, async ({ repo, simvault, scheduler }) => {
    simvault.reset(0.01); // below 0.015 → hold
    const p1 = await scheduler.pollOnce('poll');
    assert.strictEqual(p1.ran, false);
    assert.match(p1.reason, /below accumulation threshold/);
    assert.strictEqual((await repo.getCycles(10, 0)).total, 0);

    simvault.reset(0.02); // >= 0.015 → run
    const p2 = await scheduler.pollOnce('poll');
    assert.strictEqual(p2.ran, true);
    assert.strictEqual(p2.cycle.status, 'complete');
    assert.strictEqual((await repo.getCycles(10, 0)).total, 1);
  });
});

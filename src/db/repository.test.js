'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod, db, repo;

before(async () => {
  process.env.DRY_RUN = 'true';
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'ponsliqui_test_repo';
  delete require.cache[require.resolve('../config')];
  db = require('./index');
  repo = require('./repository');
  await db.connect();
});

after(async () => {
  await db.close();
  await mongod.stop();
});

test('getStats aggregates tokens_sold, eth_to_dev, and dev-fee count', async () => {
  const id = await repo.createCycle({ dryRun: true });
  await repo.addStep({ cycleId: id, name: 'dev-fee', status: 'ok', detail: {} });
  await repo.finishCycle(id, { status: 'complete', tokens_burned: 50, tokens_sold: 950, eth_to_dev: 0.5 });
  const stats = await repo.getStats();
  assert.strictEqual(stats.total_tokens_burned, 50);
  assert.strictEqual(stats.total_tokens_sold, 950);
  assert.ok(Math.abs(stats.total_eth_to_dev - 0.5) < 1e-9);
  assert.strictEqual(stats.devFees, 1);
});

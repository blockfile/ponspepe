'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

// One mongo server per file (config.mongoUri is captured at module load, so a
// second connect() in the same process would point at the first, stopped server).
test('addAirdrop + getAirdrops + getAirdropTotals round-trip', async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'ponsliqui_test_airdrops';
  const db = require('./index');
  const repo = require('./repository');
  await db.connect();
  try {
    await repo.addAirdrop({ cycleId: 1, rewardToken: 'OTHER', recipient: 'A', amountRaw: '10', amountUi: 1, signature: 's1', status: 'ok' });
    await repo.addAirdrop({ cycleId: 1, rewardToken: 'PONS', recipient: 'B', amountRaw: '20', amountUi: 2, signature: 's2', status: 'ok' });
    await repo.addAirdrop({ cycleId: 1, rewardToken: 'PONS', recipient: 'C', amountRaw: '30', amountUi: 3, signature: 's3', status: 'ok' });
    await repo.addAirdrop({ cycleId: 1, rewardToken: 'PONS', recipient: 'D', amountRaw: '40', amountUi: 4, signature: null, status: 'failed' });

    // Round-trip: all rows, newest first.
    const all = await repo.getAirdrops(10, 0);
    assert.strictEqual(all.total, 4);
    assert.strictEqual(all.items[0].recipient, 'D'); // newest first
    assert.strictEqual(all.items[3].recipient, 'A');
    assert.strictEqual(all.items[1].reward_token, 'PONS');

    // reward_token filter — powers GET /api/airdrops?token=PONS.
    const pons = await repo.getAirdrops(10, 0, 'PONS');
    assert.strictEqual(pons.total, 3);
    assert.ok(pons.items.every((i) => i.reward_token === 'PONS'));

    const none = await repo.getAirdrops(10, 0, '__none__'); // unknown token -> empty
    assert.strictEqual(none.total, 0);

    // Totals count only successful sends (the failed 'D' is excluded).
    const totals = await repo.getAirdropTotals();
    assert.strictEqual(totals.PONS.sends, 2);
    assert.strictEqual(totals.PONS.holders, 2);
    assert.strictEqual(totals.PONS.totalUi, 5); // 2 + 3
    assert.strictEqual(totals.OTHER.sends, 1);
  } finally {
    await db.close();
    await mongod.stop();
  }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

test('airdropToken (DRY_RUN) sends each allocation, records rows, computes UI amount', async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'ponsliqui_test_airdropexec';
  const db = require('../db/index');
  const repo = require('../db/repository');
  const { airdropToken } = require('./airdrop');
  await db.connect();
  try {
    const allocations = [
      { owner: '0xA', amountRaw: (10n ** 18n).toString() }, // 1.0
      { owner: '0xB', amountRaw: (2n * 10n ** 18n).toString() }, // 2.0
      { owner: '0xC', amountRaw: (3n * 10n ** 18n).toString() }, // 3.0
    ];
    const res = await airdropToken({ rewardToken: 'PONS', allocations, cycleId: 7 });
    assert.strictEqual(res.sent, 3);
    assert.strictEqual(res.failed, 0);

    const rows = await repo.getAirdrops(10, 0, 'PONS');
    assert.strictEqual(rows.total, 3);
    assert.ok(rows.items.every((r) => r.status === 'ok' && r.signature && r.signature.startsWith('airdrop_')));
    const byRecipient = Object.fromEntries(rows.items.map((r) => [r.recipient, r.amount_ui]));
    assert.strictEqual(byRecipient['0xB'], 2); // 2.0 PONS
  } finally {
    await db.close();
    await mongod.stop();
  }
});

test('airdropToken returns {0,0} for empty allocations without touching the db', async () => {
  const { airdropToken } = require('./airdrop');
  const res = await airdropToken({ rewardToken: 'PONS', allocations: [], cycleId: 1 });
  assert.deepStrictEqual(res, { sent: 0, failed: 0 });
});

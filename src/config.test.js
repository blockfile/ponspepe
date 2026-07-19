'use strict';
const test = require('node:test');
const assert = require('node:assert');

function freshConfig() {
  delete require.cache[require.resolve('./config')];
  return require('./config');
}

test('config exposes pons.family + reward-engine defaults', () => {
  const config = freshConfig();
  assert.strictEqual(config.chainId, 4663);
  assert.strictEqual(config.ponsFactory.toLowerCase(), '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb');
  assert.strictEqual(config.ponsLocker.toLowerCase(), '0x736d76699c26d0d966744cae304c000d471f7f35');
  assert.strictEqual(config.weth.toLowerCase(), '0x0bd7d308f8e1639fab988df18a8011f41eacad73');
  assert.strictEqual(config.swapRouter.toLowerCase(), '0xcaf681a66d020601342297493863e78c959e5cb2');
  // Reward token — bought with the WETH claim on Uniswap V3, then airdropped.
  assert.strictEqual(config.rewardToken, '0x39dbed3a2bd333467115de45665cc57f813c4571');
  assert.strictEqual(config.rewardSymbol, 'PONS');
  assert.strictEqual(config.rewardPoolFee, 10000);
  assert.strictEqual(config.tokenSymbol, 'PONZI');
  assert.strictEqual(config.rewardBuyPct, 80);
  assert.strictEqual(config.devPct, 20); // remainder — nothing is burned
  assert.strictEqual(config.minHold, 100000);
  assert.strictEqual(config.rewardCapPct, 0);
  // The CODE default — not whatever a local .env happens to set.
  assert.strictEqual(config.airdropBatchSize, 30);
  assert.strictEqual(config.triggerMode, 'accumulation');
  assert.strictEqual(config.claimEveryEth, 0.01);
  assert.strictEqual(config.pollSchedule, '* * * * *');
  assert.strictEqual(config.protocolFeeSharePct, 30); // pons: 70% creator / 30% protocol
  assert.strictEqual(config.deadAddress, '0x000000000000000000000000000000000000dead');
  assert.strictEqual(config.mongoDb, 'ponsliqui');
  assert.deepStrictEqual(config.clusters, []);
  assert.deepStrictEqual(config.airdropExclude, []);
});

test('token-fee split: burn/sell/dev/reserve defaults', () => {
  const config = freshConfig();
  assert.strictEqual(config.burnPct, 5); // burn 5%, sell 95%
  assert.strictEqual(config.sellSlippagePct, 5);
  assert.strictEqual(config.sellerGasReserveEth, 0.002);
  // devWallet defaults to the operating wallet address (lowercased).
  assert.strictEqual(config.devWallet, config.wallet.address.toLowerCase());
  // No SELLER_PRIVATE_KEY set in this env → null seller (DRY_RUN safe).
  assert.strictEqual(config.sellerWallet, null);
  assert.strictEqual(config.sellerAddress, null);
});

test('BURN_PCT is overridable and bounded to [0,100]', () => {
  process.env.BURN_PCT = '10';
  assert.strictEqual(freshConfig().burnPct, 10);
  process.env.BURN_PCT = '150';
  delete require.cache[require.resolve('./config')];
  assert.throws(() => require('./config'), /BURN_PCT/);
  delete process.env.BURN_PCT;
  delete require.cache[require.resolve('./config')];
});

test('DEV_WALLET overrides the ETH destination (lowercased)', () => {
  process.env.DEV_WALLET = '0xAbC0000000000000000000000000000000000001';
  assert.strictEqual(freshConfig().devWallet, '0xabc0000000000000000000000000000000000001');
  delete process.env.DEV_WALLET;
  delete require.cache[require.resolve('./config')];
});

test('no noxa / removed keys remain', () => {
  const config = freshConfig();
  assert.strictEqual(config.noxaFactory, undefined);
  assert.strictEqual(config.noxaLocker, undefined);
  assert.strictEqual(config.noxaFeeVault, undefined);
  assert.strictEqual(config.creatorFeeSharePct, undefined);
  assert.strictEqual(config.claimThresholdUsd, undefined);
  assert.strictEqual(config.buyPct, undefined);
});

test('devPct is the split remainder and the split is overridable', () => {
  process.env.REWARD_BUY_PCT = '70';
  const config = freshConfig();
  assert.strictEqual(config.rewardBuyPct, 70);
  assert.strictEqual(config.devPct, 30, 'dev cut = 100 - reward');
  delete process.env.REWARD_BUY_PCT;
  delete require.cache[require.resolve('./config')];
});

test('rejects a split outside 0–100%', () => {
  process.env.REWARD_BUY_PCT = '130';
  delete require.cache[require.resolve('./config')];
  assert.throws(() => require('./config'), /split/i);
  delete process.env.REWARD_BUY_PCT;
  delete require.cache[require.resolve('./config')];
});

test('accumulation trigger mode + CLAIM_EVERY_ETH are honored', () => {
  process.env.TRIGGER_MODE = 'accumulation';
  process.env.CLAIM_EVERY_ETH = '0.01';
  const config = freshConfig();
  assert.strictEqual(config.triggerMode, 'accumulation');
  assert.strictEqual(config.claimEveryEth, 0.01);
  delete process.env.TRIGGER_MODE;
  delete process.env.CLAIM_EVERY_ETH;
  delete require.cache[require.resolve('./config')];
});

test('CLUSTERS parses JSON groups and AIRDROP_EXCLUDE splits on commas', () => {
  process.env.CLUSTERS = '[["0xAaa","0xBbb"]]';
  process.env.AIRDROP_EXCLUDE = '0x111, 0x222 ,';
  const config = freshConfig();
  assert.deepStrictEqual(config.clusters, [['0xAaa', '0xBbb']]);
  assert.deepStrictEqual(config.airdropExclude, ['0x111', '0x222']);
  delete process.env.CLUSTERS;
  delete process.env.AIRDROP_EXCLUDE;
  delete require.cache[require.resolve('./config')];
});

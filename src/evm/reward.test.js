'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseEther } = require('ethers');
const { computeMinOut, buyParams, buyReward } = require('./reward');
const config = require('../config');

test('computeMinOut applies the slippage floor in basis points', () => {
  assert.strictEqual(computeMinOut(1000n, 5), 950n); // 5% off 1000
  assert.strictEqual(computeMinOut(1000n, 0), 1000n); // no slippage
  assert.strictEqual(computeMinOut(1000n, 2.5), 975n); // fractional percent
});

test('buyParams targets WETH -> reward token on the configured V3 fee tier', () => {
  const p = buyParams(parseEther('1'), 0n, '0xRecipient');
  assert.strictEqual(p.tokenIn.toLowerCase(), config.weth.toLowerCase());
  assert.strictEqual(p.tokenOut.toLowerCase(), config.rewardToken.toLowerCase());
  assert.strictEqual(p.fee, config.rewardPoolFee);
  assert.strictEqual(p.recipient, '0xRecipient');
  assert.strictEqual(p.amountIn, parseEther('1'));
  assert.strictEqual(p.amountOutMinimum, 0n);
  assert.strictEqual(p.sqrtPriceLimitX96, 0n);
});

test('buyReward (DRY_RUN) simulates a positive reward amount without touching the chain', async () => {
  const out = await buyReward(parseEther('1'));
  assert.strictEqual(out.simulated, true);
  assert.ok(out.boughtRaw > 0n, 'bought a positive amount');
  assert.match(out.signature, new RegExp(`^buy_${config.rewardSymbol}_`));
});

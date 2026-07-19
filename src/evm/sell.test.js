'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseEther } = require('ethers');
const { computeMinOut, sweepValue, sellParams, sellTokenForEth } = require('./sell');

test('computeMinOut applies the slippage floor (5% => 95% of quote)', () => {
  assert.strictEqual(computeMinOut(1000n, 5), 950n);
  assert.strictEqual(computeMinOut(1000n, 0), 1000n);
  assert.strictEqual(computeMinOut(0n, 5), 0n);
});

test('sweepValue leaves the gas reserve; returns 0 when balance <= reserve', () => {
  assert.strictEqual(sweepValue(parseEther('1'), 0.002), parseEther('0.998'));
  assert.strictEqual(sweepValue(parseEther('0.001'), 0.002), 0n);
  assert.strictEqual(sweepValue(parseEther('0.002'), 0.002), 0n);
});

test('sellParams sells the token FOR weth at the pool fee tier (SwapRouter02: no deadline)', () => {
  const p = sellParams({ poolFee: 10000n, pairedToken: '0xWeth' }, '0xPonspepe', 100n, 95n, '0xSeller');
  assert.strictEqual(p.tokenIn, '0xPonspepe');
  assert.strictEqual(p.tokenOut, '0xWeth');
  assert.strictEqual(p.fee, 10000n);
  assert.strictEqual(p.recipient, '0xSeller');
  assert.strictEqual(p.amountIn, 100n);
  assert.strictEqual(p.amountOutMinimum, 95n);
  assert.strictEqual(p.sqrtPriceLimitX96, 0n);
  assert.ok(!('deadline' in p), 'SwapRouter02 exactInputSingle has no deadline field');
});

test('sellTokenForEth (DRY_RUN) returns a simulated receipt without touching the chain', async () => {
  // config defaults to DRY_RUN=true in the test env
  const r = await sellTokenForEth('0x00000000000000000000000000000000000a1b69', (10n ** 21n).toString());
  assert.strictEqual(r.simulated, true);
  assert.strictEqual(r.soldRaw, 10n ** 21n);
  assert.ok(r.sold > 0, 'sold UI amount reported');
  assert.ok(r.ethReceived > 0, 'simulated ETH received');
  assert.ok(r.ethToDev > 0 && r.ethToDev <= r.ethReceived, 'ethToDev is net of reserve');
  assert.ok(typeof r.signature === 'string' && r.signature.startsWith('sell_'));
});

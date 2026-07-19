'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ethPerStockFromSqrt, poolIdFor } = require('./stockprice');
const { REGISTRY } = require('./stocks');

test('ethPerStockFromSqrt inverts the V4 sqrtPrice (token0=ETH, token1=stock)', () => {
  // Pool price stock-per-ETH = 9  ->  sqrtPrice = 3  ->  sqrtPriceX96 = 3 * 2^96.
  // So 1 stock = 1/9 ETH.
  const sqrtPriceX96 = 3n * 2n ** 96n;
  const ethPerStock = ethPerStockFromSqrt(sqrtPriceX96);
  assert.ok(Math.abs(ethPerStock - 1 / 9) < 1e-9, `expected ~${1 / 9}, got ${ethPerStock}`);
});

test('ethPerStockFromSqrt gives a realistic price at a realistic sqrtPrice', () => {
  // ~8.78 stock per ETH (NVDA-ish): sqrt ≈ 2.9631, so 1 stock ≈ 0.1139 ETH,
  // × ~$1817/ETH ≈ $207.
  const sqrtPriceX96 = BigInt(Math.round(2.9631 * 2 ** 96));
  const ethPerStock = ethPerStockFromSqrt(sqrtPriceX96);
  const usd = ethPerStock * 1817;
  assert.ok(usd > 190 && usd < 220, `expected ~$207, got $${usd.toFixed(2)}`);
});

test('ethPerStockFromSqrt rejects a zero price', () => {
  assert.strictEqual(ethPerStockFromSqrt(0n), null);
});

test('poolIdFor is deterministic and distinct per stock', () => {
  const nvda = REGISTRY.find((s) => s.symbol === 'NVDA');
  const aapl = REGISTRY.find((s) => s.symbol === 'AAPL');
  assert.strictEqual(poolIdFor(nvda), poolIdFor(nvda), 'stable');
  assert.notStrictEqual(poolIdFor(nvda), poolIdFor(aapl), 'per-pool');
  assert.match(poolIdFor(nvda), /^0x[0-9a-f]{64}$/);
});

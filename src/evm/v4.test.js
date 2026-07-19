'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { AbiCoder, ZeroAddress, parseEther, parseUnits } = require('ethers');
const { ethPoolKey, encodeSwapInput, buildBuyCall, assertSanePrice, CMD_V4_SWAP } = require('./v4');
const { REGISTRY } = require('./stocks');
const price = require('./price');

const NVDA = REGISTRY.find((s) => s.symbol === 'NVDA');
const abi = AbiCoder.defaultAbiCoder();

test('ethPoolKey puts native ETH first (address(0) always sorts first)', () => {
  const k = ethPoolKey(NVDA);
  assert.strictEqual(k.currency0, ZeroAddress, 'native ETH is currency0');
  assert.strictEqual(k.currency1, NVDA.token);
  assert.strictEqual(k.fee, 50000);
  assert.strictEqual(k.tickSpacing, 1000);
  assert.strictEqual(k.hooks, ZeroAddress);
});

test('buildBuyCall emits the V4_SWAP command and sends the ETH as value', () => {
  const amountIn = parseEther('0.01');
  const call = buildBuyCall(NVDA, amountIn, 123n);
  assert.strictEqual(call.commands, CMD_V4_SWAP, 'UniversalRouter V4_SWAP');
  assert.strictEqual(call.inputs.length, 1);
  assert.strictEqual(call.value, amountIn, 'native ETH is paid as msg.value');
  assert.ok(call.deadline > 0n);
});

test('encodeSwapInput carries actions SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL', () => {
  const amountIn = parseEther('0.01');
  const input = encodeSwapInput({
    poolKey: ethPoolKey(NVDA),
    zeroForOne: true,
    amountIn,
    amountOutMin: 5n,
    currencyIn: ZeroAddress,
    currencyOut: NVDA.token,
  });

  const [actions, params] = abi.decode(['bytes', 'bytes[]'], input);
  assert.strictEqual(actions, '0x060c0f', 'SWAP_EXACT_IN_SINGLE(0x06), SETTLE_ALL(0x0c), TAKE_ALL(0x0f)');
  assert.strictEqual(params.length, 3, 'one param per action');

  // SETTLE_ALL pays the exact input; TAKE_ALL receives at least the minimum.
  const [settleCurrency, settleAmount] = abi.decode(['address', 'uint256'], params[1]);
  assert.strictEqual(settleCurrency, ZeroAddress);
  assert.strictEqual(settleAmount, amountIn);

  const [takeCurrency, takeMin] = abi.decode(['address', 'uint256'], params[2]);
  assert.strictEqual(takeCurrency.toLowerCase(), NVDA.token);
  assert.strictEqual(takeMin, 5n, 'slippage floor is enforced on the take');
});

// The empty-pool trap: several V4 pools on this chain are initialised but hold
// no real liquidity and quote absurd prices (TSM implied ~$179,000,000/share vs
// a real ~$408). amountOutMinimum can't protect against it — it's derived from
// the same poisoned quote — so the implied price is checked directly.
test('assertSanePrice accepts a real quote', async () => {
  price._prime(1817); // deterministic ETH price — no network
  // 0.01 ETH -> 0.0859 NVDA  => ~$211/share, which is sane.
  const implied = await assertSanePrice(NVDA, parseEther('0.01'), parseUnits('0.0859', 18));
  assert.ok(implied > 200 && implied < 220, `implied ~$211, got ${implied}`);
});

test('assertSanePrice REFUSES an empty pool quoting an absurd price (the TSM/AVGO case)', async () => {
  price._prime(1817);
  // The real TSM quote: 0.01 ETH -> 0.000000101493 units => ~$179M/share.
  await assert.rejects(
    () => assertSanePrice({ ...NVDA, symbol: 'TSM' }, parseEther('0.01'), parseUnits('0.000000101493', 18)),
    /TSM pool looks broken/,
    'must refuse to burn ETH on a dust pool'
  );
});

test('assertSanePrice rejects a zero-unit quote', async () => {
  price._prime(1817);
  await assert.rejects(() => assertSanePrice(NVDA, parseEther('0.01'), 0n), /returned 0 units/);
});

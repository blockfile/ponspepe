'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { REGISTRY, resolveStocks } = require('./stocks');

test('registry is exactly the 10 assets with a verified, sanely-priced V4 ETH pool', () => {
  assert.strictEqual(REGISTRY.length, 10, '10 assets airdropped per wallet');
  const symbols = REGISTRY.map((s) => s.symbol);
  for (const expected of ['NVDA', 'AAPL', 'TSLA', 'SPCX', 'GOOGL', 'MSFT', 'META', 'AMZN', 'AMD', 'SPY']) {
    assert.ok(symbols.includes(expected), `${expected} is buyable with ETH on V4`);
  }
  // Assets whose ETH pool is initialised but EMPTY (absurd quotes) must stay out
  // — buying through one burns the ETH for dust.
  for (const broken of ['TSM', 'AVGO', 'COIN', 'INTC', 'ORCL', 'MU', 'NFLX', 'QQQ', 'SLV', 'GME']) {
    assert.ok(!symbols.includes(broken), `${broken} has a broken/empty pool and must be excluded`);
  }
  // Gold/silver are not obtainable on this chain at all.
  for (const metal of ['XAU', 'XAG', 'XAUT', 'PAXG']) {
    assert.ok(!symbols.includes(metal), `${metal} has no usable pool`);
  }
});

test('every registry entry carries the V4 pool key and a pinned address', () => {
  for (const s of REGISTRY) {
    assert.match(s.token, /^0x[0-9a-f]{40}$/, `${s.symbol} address is pinned + normalised`);
    assert.strictEqual(s.fee, 50000, `${s.symbol} uses the 5% tier`);
    assert.strictEqual(s.tickSpacing, 1000);
    assert.strictEqual(s.hooks, '0x0000000000000000000000000000000000000000');
    assert.strictEqual(s.decimals, 18);
  }
});

test('resolveStocks: blank = all, symbols are case-insensitive, unknown throws', () => {
  assert.strictEqual(resolveStocks([]).length, REGISTRY.length);
  assert.strictEqual(resolveStocks(null).length, REGISTRY.length);

  const picked = resolveStocks(['nvda', ' TSLA ']);
  assert.deepStrictEqual(picked.map((s) => s.symbol), ['NVDA', 'TSLA']);

  // A typo must fail loudly rather than silently airdropping fewer stocks.
  assert.throws(() => resolveStocks(['NVDA', 'NOPE']), /unknown stock "NOPE"/);
});

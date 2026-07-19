'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { computeWeightedAllocations } = require('./distribution');

// helper: turn result into { owner: amount } and the integer sum
function toMap(out) {
  const m = {};
  let sum = 0n;
  for (const { owner, amountRaw } of out) {
    m[owner] = (m[owner] || 0n) + BigInt(amountRaw);
    sum += BigInt(amountRaw);
  }
  return { m, sum };
}

test('pro-rata by balance when no cap (Leg B shape)', () => {
  const out = computeWeightedAllocations(
    [{ owner: 'A', balanceRaw: '100' }, { owner: 'B', balanceRaw: '300' }],
    '400',
    { capPct: null }
  );
  const { m, sum } = toMap(out);
  assert.strictEqual(sum, 400n);
  assert.strictEqual(m.A, 100n); // 400 * 100/400
  assert.strictEqual(m.B, 300n); // 400 * 300/400
});

test('caps a whale at 2% of supply (Leg A shape)', () => {
  // supply 1,000,000 -> 2% cap = 20,000. Whale holds 500,000 (capped to 20,000),
  // small holder 20,000 (uncapped). Equal weights -> equal split of 1,000.
  const out = computeWeightedAllocations(
    [{ owner: 'WHALE', balanceRaw: '500000' }, { owner: 'SMALL', balanceRaw: '20000' }],
    '1000',
    { capPct: 2, supplyRaw: '1000000' }
  );
  const { m, sum } = toMap(out);
  assert.strictEqual(sum, 1000n);
  assert.strictEqual(m.WHALE, 500n);
  assert.strictEqual(m.SMALL, 500n);
});

test('clustered wallets are capped as one entity, then split by internal balance', () => {
  // Cluster [X,Y] combined 30,000 capped at 20,000 (2% of 1,000,000). Z holds 20,000.
  // Two entities, equal capped weight -> 500 each. Cluster's 500 splits X:Y = 10000:20000 = 167:333.
  const out = computeWeightedAllocations(
    [
      { owner: 'X', balanceRaw: '10000' },
      { owner: 'Y', balanceRaw: '20000' },
      { owner: 'Z', balanceRaw: '20000' },
    ],
    '1000',
    { capPct: 2, supplyRaw: '1000000', clusters: [['X', 'Y']] }
  );
  const { m, sum } = toMap(out);
  assert.strictEqual(sum, 1000n);
  assert.strictEqual(m.Z, 500n);
  assert.strictEqual(m.X + m.Y, 500n);
  assert.strictEqual(m.X, 167n); // floor(500 * 10000/30000) = 166 + 1 largest-remainder
  assert.strictEqual(m.Y, 333n); // floor(500 * 20000/30000) = 333
});

test('largest-remainder makes the sum exact (no dust, no overflow)', () => {
  const out = computeWeightedAllocations(
    [{ owner: 'A', balanceRaw: '1' }, { owner: 'B', balanceRaw: '1' }, { owner: 'C', balanceRaw: '1' }],
    '7', // 7/3 = 2 each + 1 leftover -> someone gets 3
    { capPct: null }
  );
  const { sum } = toMap(out);
  assert.strictEqual(sum, 7n);
  assert.strictEqual(out.length, 3);
});

test('returns [] for empty / zero / all-zero-balance inputs', () => {
  assert.deepStrictEqual(computeWeightedAllocations([], '100', { capPct: null }), []);
  assert.deepStrictEqual(
    computeWeightedAllocations([{ owner: 'A', balanceRaw: '5' }], '0', { capPct: null }),
    []
  );
  assert.deepStrictEqual(
    computeWeightedAllocations([{ owner: 'A', balanceRaw: '0' }], '100', { capPct: null }),
    []
  );
});

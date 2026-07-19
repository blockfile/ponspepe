'use strict';
const test = require('node:test');
const assert = require('node:assert');
const simvault = require('./simvault');

test('simvault accrues, peeks without mutating, and drains to zero', () => {
  simvault.reset(0);
  assert.strictEqual(simvault.peek(), 0);
  assert.strictEqual(simvault.accrue(0.5), 0.5);
  assert.strictEqual(simvault.accrue(0.5), 1);
  assert.strictEqual(simvault.peek(), 1); // peek does not mutate
  assert.strictEqual(simvault.peek(), 1);
  assert.strictEqual(simvault.drain(), 1);
  assert.strictEqual(simvault.peek(), 0); // drained
});

test('simvault.reset forces a known balance', () => {
  assert.strictEqual(simvault.reset(2.5), 2.5);
  assert.strictEqual(simvault.peek(), 2.5);
  simvault.reset(0);
});

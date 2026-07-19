'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pons = require('./pons');
const simvault = require('./simvault');

test('exports the claim/estimate API', () => {
  for (const fn of [
    'getLaunchedToken',
    'launcherToken',
    'getUncollectedLpFees',
    'getClaimableEth',
    'simulateFeeAccrual',
    'claimCreatorFees',
  ]) {
    assert.strictEqual(typeof pons[fn], 'function', `missing ${fn}`);
  }
});

test('DRY_RUN: simulateFeeAccrual accrues and getClaimableEth reads the simulated vault', async () => {
  simvault.reset(0);
  pons.simulateFeeAccrual(); // adds dryRunFeePerPoll (0.01)
  const claimable = await pons.getClaimableEth();
  assert.ok(claimable > 0, 'expected simulated fees to accrue');
});

test('DRY_RUN: claimCreatorFees drains the simulated vault and marks it simulated', async () => {
  simvault.reset(0.05);
  const claim = await pons.claimCreatorFees();
  assert.strictEqual(claim.simulated, true);
  assert.ok(Math.abs(claim.ethClaimed - 0.05) < 1e-9, `ethClaimed=${claim.ethClaimed}`);
  assert.strictEqual(simvault.peek(), 0); // drained
  assert.match(claim.signature, /^claim_/);
});

test('live claim path targets the Pons locker collectFees, not a fee-vault collect', () => {
  const src = fs.readFileSync(path.join(__dirname, 'pons.js'), 'utf8');
  assert.match(src, /collectFees\(/, 'must claim via locker.collectFees');
  assert.match(src, /config\.ponsLocker/, 'must use the Pons locker');
  assert.doesNotMatch(src, /noxaFeeVault|\.collect\(config\.tokenAddress\)/, 'must not use the NOXA fee vault');
});

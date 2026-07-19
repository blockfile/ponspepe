'use strict';

// Claim creator fees from the pons.family locker (collectFees(TOKEN_ADDRESS)).
//   node scripts/claim.js [--confirm]
const { config, hr, requireConfirm } = require('./_util');
const { getClaimableEth, claimCreatorFees } = require('../src/evm/pons');

(async () => {
  hr('CLAIM CREATOR FEES');
  const claimable = await getClaimableEth();
  console.log('claimable  :', claimable, 'ETH (creator share, estimated)');

  if (!(await requireConfirm(`claim ~${claimable} ETH of creator fees for ${config.tokenAddress}`))) {
    process.exit(0);
  }
  const result = await claimCreatorFees();
  console.log('\nresult:', JSON.stringify(result, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ FAILED:', e.message);
  process.exit(1);
});

'use strict';

// Run ONE full cycle (claim → buy → burn) and record it. The integration test.
// Amounts are driven by the actual claimed fees.
//   node scripts/run-once.js [--confirm]
const { requireConfirm, hr } = require('./_util');
const db = require('../src/db');
const { runCycle } = require('../src/jobs/cycle');

(async () => {
  hr('RUN ONE FULL CYCLE');
  if (!(await requireConfirm('run one full cycle (claim → buy → burn)'))) {
    process.exit(0);
  }
  await db.connect();
  const cycle = await runCycle();
  console.log('\ncycle result:');
  console.log(JSON.stringify(cycle, null, 2));
  await db.close();
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ FAILED:', e.message);
  process.exit(1);
});

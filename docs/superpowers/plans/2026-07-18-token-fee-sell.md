# Token-side Fee: Burn + Disclosed Dev-Fee Sell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 100%-burn of the token-side creator fee with a configurable split — burn `BURN_PCT`, sell the rest to ETH from a disclosed fee-conversion wallet, and pay the ETH to the dev — reported honestly (never as a "burn").

**Architecture:** A new `src/evm/sell.js` module owns a second signer (`SELLER_PRIVATE_KEY`) and sells RIF→WETH on the pons.family Uniswap **V3** launch pool (quote-then-swap via the existing `SWAP_ROUTER`), unwraps to native ETH, and sweeps it to `DEV_WALLET` minus a gas reserve. `src/jobs/cycle.js` splits its single burn step into a `burn` step (`BURN_PCT`) and a `dev-fee` step (the remainder). Reporting tracks `tokens_burned` and `tokens_sold`/`eth_to_dev` separately.

**Tech Stack:** Node.js ≥20 (CommonJS), ethers v6, `node --test` + `node:assert`, MongoDB (mongodb-memory-server in tests).

## Global Constraints

- **Disclosure is a hard requirement.** The sold portion is NEVER labeled `burn`. Only what reaches the dead address is a burn. Receipts/`/v1`/README report `tokens_sold` + `eth_to_dev` separately and name the seller + dev wallets. (Spec: "Disclosure (non-negotiable)".)
- **Best-effort, non-fatal.** A failed burn or failed sell must be recorded and must NOT fail the cycle or block the stock airdrops (matches today's burn behavior).
- **Reward leg unchanged.** Stock buys are still funded ONLY by the claimed WETH. The sold ETH is NOT added to the reward budget.
- **No hardcoded pool params.** `poolFee`/token-ordering come from the on-chain launch record (`getLaunchedToken`).
- **Measure, don't trust.** ETH/token amounts received are read from balance deltas, never trusted from a router return value (matches `buyStockWithEth`).
- **Nonce-safe sends** via `sendTx` (`src/evm/send.js`) — the bot fires several txs per cycle.
- **Values in dry-run branches must be deterministic** except signatures (existing modules use `Date.now()` only for fake signatures).

---

### Task 1: Config — seller wallet + split/dev/slippage/reserve settings

**Files:**
- Modify: `src/config.js`
- Modify: `.env.example`
- Test: `src/config.test.js`

**Interfaces:**
- Produces:
  - `config.burnPct: number` — % of the token-side fee burned (default 5, range [0,100]).
  - `config.sellSlippagePct: number` — RIF→WETH slippage floor, percent (default 5).
  - `config.sellerGasReserveEth: number` — native ETH left in the seller wallet each cycle (default 0.002).
  - `config.devWallet: string` — lowercased ETH destination; defaults to the operating wallet address.
  - `config.sellerWallet: import('ethers').Wallet | null` — the disclosed seller signer, or null if `SELLER_PRIVATE_KEY` unset.
  - `config.sellerAddress: string | null` — lowercased seller address, or null.

- [ ] **Step 1: Write the failing config test**

Add to `src/config.test.js`:

```js
test('token-fee split: burn/sell/dev/reserve defaults', () => {
  const config = freshConfig();
  assert.strictEqual(config.burnPct, 5); // burn 5%, sell 95%
  assert.strictEqual(config.sellSlippagePct, 5);
  assert.strictEqual(config.sellerGasReserveEth, 0.002);
  // devWallet defaults to the operating wallet address (lowercased).
  assert.strictEqual(config.devWallet, config.wallet.address.toLowerCase());
  // No SELLER_PRIVATE_KEY set in this env → null seller (DRY_RUN safe).
  assert.strictEqual(config.sellerWallet, null);
  assert.strictEqual(config.sellerAddress, null);
});

test('BURN_PCT is overridable and bounded to [0,100]', () => {
  process.env.BURN_PCT = '10';
  assert.strictEqual(freshConfig().burnPct, 10);
  process.env.BURN_PCT = '150';
  delete require.cache[require.resolve('./config')];
  assert.throws(() => require('./config'), /BURN_PCT/);
  delete process.env.BURN_PCT;
  delete require.cache[require.resolve('./config')];
});

test('DEV_WALLET overrides the ETH destination (lowercased)', () => {
  process.env.DEV_WALLET = '0xAbC0000000000000000000000000000000000001';
  assert.strictEqual(freshConfig().devWallet, '0xabc0000000000000000000000000000000000001');
  delete process.env.DEV_WALLET;
  delete require.cache[require.resolve('./config')];
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/config.test.js`
Expected: FAIL — `config.burnPct` is `undefined`.

- [ ] **Step 3: Implement the config additions**

In `src/config.js`, after `loadWallet()` / `const { wallet, ... } = loadWallet();` (around line 64), add a seller loader:

```js
/**
 * The DISCLOSED fee-conversion wallet: it receives the sell-side token-fee,
 * sells it to ETH, and forwards the ETH to DEV_WALLET. Publicly documented as a
 * project wallet (see README) — not a way to obscure attribution. Optional in
 * DRY_RUN and when BURN_PCT=100 (nothing is sold); required otherwise.
 */
function loadSellerWallet() {
  const raw = process.env.SELLER_PRIVATE_KEY;
  if (!raw) return null;
  try {
    const key = raw.trim().startsWith('0x') ? raw.trim() : `0x${raw.trim()}`;
    return new Wallet(key);
  } catch (err) {
    throw new Error(`Could not parse SELLER_PRIVATE_KEY: ${err.message}`);
  }
}

const sellerWallet = loadSellerWallet();
```

Add the split validation near the `rewardBuyPct` validation (around line 71-75):

```js
const burnPct = num(process.env.BURN_PCT, 5);
if (burnPct < 0 || burnPct > 100) {
  throw new Error(`invalid BURN_PCT(${burnPct}) — must be within [0, 100]`);
}
// A live cycle that sells (BURN_PCT < 100) needs the seller wallet.
if (!DRY_RUN && burnPct < 100 && !sellerWallet) {
  throw new Error('SELLER_PRIVATE_KEY is required when DRY_RUN=false and BURN_PCT < 100');
}
```

In the `config` object literal, add (place near the "Split" section, around line 137-142):

```js
  // ── Token-side fee split (burn vs disclosed dev-fee sell) ─────────────────
  burnPct, // % of the token-side fee burned; the rest is sold to ETH for the dev
  sellSlippagePct: num(process.env.SELL_SLIPPAGE_PCT, 5), // RIF→WETH slippage floor
  sellerGasReserveEth: num(process.env.SELLER_GAS_RESERVE_ETH, 0.002), // ETH kept for gas
  sellerWallet, // disclosed fee-conversion signer (or null)
  sellerAddress: sellerWallet ? sellerWallet.address.toLowerCase() : null,
  devWallet: lowerOrNull(process.env.DEV_WALLET) || wallet.address.toLowerCase(),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/config.test.js`
Expected: PASS (all config tests, including the 3 new ones).

- [ ] **Step 5: Update `.env.example`**

In `.env.example`, replace the `DEAD_ADDRESS=...` line's section with the split settings (keep `DEAD_ADDRESS`):

```bash
# ── Token-side fee: burn + disclosed dev-fee sell ────────────────────────────
# Each cycle, the token-side creator fee (RIF the wallet holds) is split:
#   BURN_PCT %      → burned (sent to DEAD_ADDRESS)
#   the remainder   → sold to ETH on the V3 launch pool by SELLER wallet, and the
#                     ETH is sent to DEV_WALLET. This is a DISCLOSED dev fee — the
#                     seller wallet is documented publicly (README + /v1). It is
#                     never reported as a "burn".
BURN_PCT=5
# The disclosed fee-conversion wallet (0x-prefixed hex private key). Receives the
# sell-side RIF, sells it, forwards ETH to DEV_WALLET. Must be pre-funded with a
# little native ETH for gas. Required when DRY_RUN=false and BURN_PCT < 100.
SELLER_PRIVATE_KEY=
# ETH destination for the sale proceeds. Blank → the operating wallet.
DEV_WALLET=
SELL_SLIPPAGE_PCT=5                 # RIF->WETH slippage tolerance, percent
SELLER_GAS_RESERVE_ETH=0.002        # ETH left in the seller wallet each cycle for gas
```

- [ ] **Step 6: Commit**

```bash
git add src/config.js src/config.test.js .env.example
git commit -m "feat(config): add token-fee split settings (burn/sell/dev/reserve/seller)"
```

---

### Task 2: `sell.js` — pure helpers + DRY_RUN receipt

**Files:**
- Create: `src/evm/sell.js`
- Test: `src/evm/sell.test.js`

**Interfaces:**
- Consumes: `config` (Task 1), `src/evm/provider.js` (`provider`), `src/evm/erc20.js` (`erc20`, `wethContract`, `readTokenBalance`, `getDecimals`), `src/evm/send.js` (`sendTx`), `src/evm/pons.js` (`getLaunchedToken`).
- Produces:
  - `computeMinOut(quotedRaw: bigint, slippagePct: number): bigint` — slippage floor.
  - `sweepValue(balanceWei: bigint, reserveEth: number): bigint` — ETH to forward (0 if ≤ reserve).
  - `sellTokenForEth(token: string, amountRaw: string): Promise<{signature, soldRaw: bigint, sold: number, ethReceived: number, ethToDev: number, simulated: boolean}>`

- [ ] **Step 1: Write failing tests for the pure helpers + dry-run**

Create `src/evm/sell.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseEther } = require('ethers');
const { computeMinOut, sweepValue, sellTokenForEth } = require('./sell');

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test src/evm/sell.test.js`
Expected: FAIL — `Cannot find module './sell'`.

- [ ] **Step 3: Implement `sell.js` helpers + dry-run branch**

Create `src/evm/sell.js`:

```js
'use strict';

// Sell the token-side creator fee (RIF) to ETH from the DISCLOSED fee-conversion
// wallet, and forward the ETH to the dev wallet. This is the sell leg of the
// burn/sell split — it is NEVER a "burn" and is reported as a dev fee.
//
// RIF is a pons.family launch: its liquidity is a Uniswap V3 pool (RIF/WETH)
// whose fee tier + token ordering come from the launch record. We quote by
// static-calling the router's exactInputSingle (amountOutMinimum=0), apply a
// slippage floor to the real swap, unwrap WETH → native ETH, then sweep to the
// dev wallet minus a gas reserve.

const { Contract, MaxUint256, parseEther, formatEther, formatUnits } = require('ethers');
const config = require('../config');
const { provider } = require('./provider');
const { erc20, wethContract, readTokenBalance, getDecimals } = require('./erc20');
const { getLaunchedToken } = require('./pons');
const { sendTx } = require('./send');

// Uniswap V3 SwapRouter (original, with deadline in the struct). If the on-chain
// router is SwapRouter02 (no deadline), the probe in scripts/verify-sell-route.js
// will flag it and this ABI + the params object drop the `deadline` field.
const V3_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
];

/** Slippage floor: quotedRaw * (100 - slippagePct)%, in basis points. */
function computeMinOut(quotedRaw, slippagePct) {
  return (BigInt(quotedRaw) * BigInt(Math.round((100 - slippagePct) * 100))) / 10000n;
}

/** ETH to forward to the dev: balance minus the gas reserve (0 if not above it). */
function sweepValue(balanceWei, reserveEth) {
  const reserve = parseEther(String(reserveEth));
  const v = BigInt(balanceWei) - reserve;
  return v > 0n ? v : 0n;
}

const sellerSigner = config.sellerWallet ? config.sellerWallet.connect(provider) : null;

function fakeSig() {
  return `sell_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Sell `amountRaw` of `token` to ETH from the seller wallet and forward the ETH
 * to config.devWallet. Best-effort caller handles failures.
 */
async function sellTokenForEth(token, amountRaw) {
  const amount = BigInt(amountRaw || '0');

  if (config.dryRun) {
    // Simulate ~1 ETH per 1000 RIF so a dry cycle has plausible numbers.
    const ethReceived = Number(amount) / 1e18 / 1000;
    const ethToDev = Math.max(0, ethReceived - config.sellerGasReserveEth);
    return {
      signature: fakeSig(),
      soldRaw: amount,
      sold: Number(amount) / 1e18,
      ethReceived,
      ethToDev,
      simulated: true,
    };
  }

  if (amount <= 0n) throw new Error(`nothing to sell (amount ${amountRaw})`);
  if (!sellerSigner) throw new Error('SELLER_PRIVATE_KEY not configured');

  // (Live path implemented in Task 5.)
  throw new Error('live sell path not implemented yet');
}

module.exports = { computeMinOut, sweepValue, sellTokenForEth, sellerSigner, V3_ROUTER_ABI };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test src/evm/sell.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/evm/sell.js src/evm/sell.test.js
git commit -m "feat(sell): add sell.js helpers + DRY_RUN receipt for the dev-fee sell"
```

---

### Task 3: `cycle.js` — split the burn step into `burn` + `dev-fee`

**Files:**
- Modify: `src/jobs/cycle.js` (the burn block, ~lines 114-135, and the `finishCycle` call ~lines 174-185)
- Test: `src/jobs/cycle.test.js`

**Interfaces:**
- Consumes: `sellTokenForEth` (Task 2), `config.burnPct`, `config.sellerAddress`, `config.devWallet`.
- Produces: cycles now carry `tokens_sold` + `eth_to_dev`; steps now include a `dev-fee` step after `burn`.

- [ ] **Step 1: Extend the cycle test**

Add to `src/jobs/cycle.test.js` (inside the existing complete-cycle test, after the `tokens_burned` assertion on ~line 47; and a new standalone test):

Add these assertions to the first test (after line 47 `assert.ok(cycle.tokens_burned > 0 ...)`):

```js
  // The token-side fee is SPLIT: burn 5%, sell 95% as a disclosed dev fee.
  assert.strictEqual(names[2], 'dev-fee', 'dev-fee sell recorded right after the burn');
  const devFee = cycle.steps.find((s) => s.name === 'dev-fee');
  assert.strictEqual(devFee.status, 'ok');
  assert.ok(cycle.tokens_sold > 0, 'RIF was sold, not burned');
  assert.ok(cycle.tokens_sold > cycle.tokens_burned, '95% sold vs 5% burned');
  assert.ok(cycle.eth_to_dev > 0, 'sale proceeds recorded for the dev');
  assert.strictEqual(devFee.detail.devWallet, config.wallet.address.toLowerCase());
```

At the top of that test file's first test, `config` must be in scope — add near the other requires in `before()` (line ~24): `config = require('../config');` and declare `let config;` with the other `let` decls (line ~9-13). (It is loaded fresh after `TOKEN_ADDRESS` is set.)

Add a new back-compat test at the end of the file:

```js
test('BURN_PCT=100 reproduces burn-only behavior (no dev-fee sell)', async () => {
  process.env.BURN_PCT = '100';
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../evm/sell')];
  delete require.cache[require.resolve('./cycle')];
  const { runCycle: runCycle100 } = require('./cycle');
  simvault.reset(0.05);
  const cycle = await runCycle100();
  assert.ok(cycle.steps.some((s) => s.name === 'burn'));
  assert.ok(!cycle.steps.some((s) => s.name === 'dev-fee'), 'nothing sold when BURN_PCT=100');
  assert.ok(!(cycle.tokens_sold > 0));
  delete process.env.BURN_PCT;
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../evm/sell')];
  delete require.cache[require.resolve('./cycle')];
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test src/jobs/cycle.test.js`
Expected: FAIL — `names[2]` is a stock `buy`, not `dev-fee`; `cycle.tokens_sold` is undefined.

- [ ] **Step 3: Implement the split in `cycle.js`**

Add the import near the other evm imports (top of file, ~line 7):

```js
const { sellTokenForEth } = require('../evm/sell');
```

Replace the burn block (current ~lines 114-135) with:

```js
    // 2. Split the wallet's token-side fee. Burn BURN_PCT to the dead address;
    //    sell the remainder to ETH from the DISCLOSED seller wallet and send the
    //    ETH to the dev. Both legs are best-effort — a failure here must never
    //    strand the stock airdrops. The sell is NEVER labeled a burn.
    let burned = 0;
    let burnSig = null;
    let sold = 0;
    let ethToDev = 0;
    let devFeeSig = null;
    const feeBalRaw = config.dryRun
      ? 10n ** 21n // simulate ~1000 RIF so a dry cycle exercises both legs
      : await readTokenBalance(config.tokenAddress, config.wallet.address).catch(() => 0n);
    if (feeBalRaw > 0n) {
      const burnRaw = (feeBalRaw * BigInt(Math.round(config.burnPct * 100))) / 10000n;
      const sellRaw = feeBalRaw - burnRaw;

      if (burnRaw > 0n) {
        try {
          const burn = await burnToken(config.tokenAddress, burnRaw.toString());
          await repo.addStep({ cycleId: id, name: 'burn', status: 'ok', signature: burn.signature, detail: { token: config.tokenAddress, tokensBurned: burn.burned, burnedRaw: burn.burnedRaw, deadAddress: burn.deadAddress, pct: config.burnPct } });
          burned = burn.burned;
          burnSig = burn.signature;
          log(`burned ${burn.burned} ${config.tokenSymbol} (${config.burnPct}%) → ${burn.deadAddress}`);
        } catch (err) {
          await repo.addStep({ cycleId: id, name: 'burn', status: 'failed', detail: { message: err.message } });
          log(`burn ${config.tokenSymbol} failed (non-fatal): ${err.message}`);
        }
      }

      if (sellRaw > 0n) {
        try {
          const sale = await sellTokenForEth(config.tokenAddress, sellRaw.toString());
          await repo.addStep({ cycleId: id, name: 'dev-fee', status: 'ok', signature: sale.signature, detail: { token: config.tokenAddress, tokensSold: sale.sold, ethReceived: sale.ethReceived, ethToDev: sale.ethToDev, pct: +(100 - config.burnPct).toFixed(6), seller: config.sellerAddress, devWallet: config.devWallet } });
          sold = sale.sold;
          ethToDev = sale.ethToDev;
          devFeeSig = sale.signature;
          log(`sold ${sale.sold} ${config.tokenSymbol} (${100 - config.burnPct}%) → ${sale.ethToDev} ETH → dev ${config.devWallet}`);
        } catch (err) {
          await repo.addStep({ cycleId: id, name: 'dev-fee', status: 'failed', detail: { message: err.message } });
          log(`dev-fee sell ${config.tokenSymbol} failed (non-fatal): ${err.message}`);
        }
      }
    }
```

In the `finishCycle` call for the complete path (~lines 174-185), add the two fields and the sig, and update the note:

```js
      tokens_burned: burned,
      tokens_sold: sold,
      eth_to_dev: ethToDev,
      burn_sig: burnSig,
      dev_fee_sig: devFeeSig,
```

And change the `note` string to reflect both legs:

```js
      note: `burned ${burned} + sold ${sold} ${config.tokenSymbol} (→ ${ethToDev} ETH dev); airdropped ${reward.stocks.filter((s) => !s.error).length} stocks, ${reward.sent} sends (${reward.failed} failed)`,
```

Also add `tokens_burned: burned, tokens_sold: sold, eth_to_dev: ethToDev, burn_sig: burnSig` to the early `skipped` `finishCycle` (the "nothing claimed (WETH)" path, ~line 142) so a skipped cycle still records what it burned/sold. (`tokens_sold`/`eth_to_dev` already computed above it.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --test src/jobs/cycle.test.js`
Expected: PASS (both existing tests + the 2 additions/new test).

- [ ] **Step 5: Commit**

```bash
git add src/jobs/cycle.js src/jobs/cycle.test.js
git commit -m "feat(cycle): split token-fee into burn + disclosed dev-fee sell"
```

---

### Task 4: Reporting — repository fields + `/v1` stats

**Files:**
- Modify: `src/db/repository.js` (`createCycle`, `finishCycle` allowlist, `getStats`)
- Modify: `src/services/v1.js` (`buildStats`)
- Test: `src/db/repository.test.js` (create if absent), `src/services/v1.test.js` (extend if present, else create)

**Interfaces:**
- Consumes: cycle docs with `tokens_sold`, `eth_to_dev`, `dev_fee_sig` (Task 3).
- Produces: `getStats()` returns `total_tokens_sold`, `total_eth_to_dev`, `devFees`; `/v1/stats` returns `rifSold`, `ethToDev`, `devFees`.

- [ ] **Step 1: Write the failing repository test**

Create `src/db/repository.test.js`:

```js
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod, db, repo;

before(async () => {
  process.env.DRY_RUN = 'true';
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'ponsliqui_test_repo';
  delete require.cache[require.resolve('../config')];
  db = require('./index');
  repo = require('./repository');
  await db.connect();
});

after(async () => {
  await db.close();
  await mongod.stop();
});

test('getStats aggregates tokens_sold, eth_to_dev, and dev-fee count', async () => {
  const id = await repo.createCycle({ dryRun: true });
  await repo.addStep({ cycleId: id, name: 'dev-fee', status: 'ok', detail: {} });
  await repo.finishCycle(id, { status: 'complete', tokens_burned: 50, tokens_sold: 950, eth_to_dev: 0.5 });
  const stats = await repo.getStats();
  assert.strictEqual(stats.total_tokens_burned, 50);
  assert.strictEqual(stats.total_tokens_sold, 950);
  assert.ok(Math.abs(stats.total_eth_to_dev - 0.5) < 1e-9);
  assert.strictEqual(stats.devFees, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test src/db/repository.test.js`
Expected: FAIL — `stats.total_tokens_sold` is undefined.

- [ ] **Step 3: Implement the repository changes**

In `createCycle` (insertOne doc, ~lines 23-36) add after `tokens_burned: null,`:

```js
    tokens_sold: null,
    eth_to_dev: null,
    dev_fee_sig: null,
```

In `finishCycle` `allowed` array (~lines 43-55) add:

```js
    'tokens_sold',
    'eth_to_dev',
    'dev_fee_sig',
```

In `getStats` aggregation `$group` (~lines 144-153) add:

```js
          total_tokens_sold: { $sum: { $ifNull: ['$tokens_sold', 0] } },
          total_eth_to_dev: { $sum: { $ifNull: ['$eth_to_dev', 0] } },
```

After the `burns` count (~line 170) add:

```js
  const devFees = await db.collection('steps').countDocuments({ name: 'dev-fee', status: 'ok' });
```

In the fallback object (~lines 173-181) add `total_tokens_sold: 0, total_eth_to_dev: 0,` and in the return object add `devFees,`.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test src/db/repository.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing `/v1` stats test**

Create/extend `src/services/v1.test.js` with a focused unit check of the new fields. If the file doesn't exist, create it mirroring the repository test's mongo setup, then:

```js
test('/v1 stats exposes rifSold, ethToDev, devFees (honest, separate from burns)', async () => {
  const { buildStats } = require('./v1');
  const id = await repo.createCycle({ dryRun: true });
  await repo.addStep({ cycleId: id, name: 'dev-fee', status: 'ok', detail: {} });
  await repo.finishCycle(id, { status: 'complete', tokens_burned: 50, tokens_sold: 950, eth_to_dev: 0.5 });
  const stats = await buildStats();
  assert.strictEqual(stats.rifBurned, 50);
  assert.strictEqual(stats.rifSold, 950);
  assert.ok(Math.abs(stats.ethToDev - 0.5) < 1e-9);
  assert.strictEqual(stats.devFees, 1);
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `node --test src/services/v1.test.js`
Expected: FAIL — `stats.rifSold` is undefined.

- [ ] **Step 7: Implement the `/v1` changes**

In `src/services/v1.js` `buildStats` return object (~lines 57-73), after `rifBurned: stats.total_tokens_burned || 0,` add:

```js
    rifSold: stats.total_tokens_sold || 0, // token-side fee RIF sold to ETH for the dev (NOT burned)
    ethToDev: +(stats.total_eth_to_dev || 0).toFixed(6), // ETH sent to the dev from selling the fee
    devFees: stats.devFees || 0, // count of dev-fee sells performed
```

- [ ] **Step 8: Run to verify it passes**

Run: `node --test src/services/v1.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/db/repository.js src/db/repository.test.js src/services/v1.js src/services/v1.test.js
git commit -m "feat(reporting): track tokens_sold + eth_to_dev separately from burns"
```

---

### Task 5: `sell.js` — live V3 sell path (quote → swap → unwrap → sweep)

**Files:**
- Modify: `src/evm/sell.js`
- Test: `src/evm/sell.test.js` (helper-level; live send exercised via the probe in Task 6 + DRY_RUN in cycle.test)

**Interfaces:**
- Consumes: `V3_ROUTER_ABI`, `computeMinOut`, `sweepValue` (Task 2); `getLaunchedToken` (`poolFee`, `isToken0`); `config.swapRouter`, `config.weth`, `config.devWallet`, `config.sellSlippagePct`, `config.sellerGasReserveEth`.
- Produces: the completed `sellTokenForEth` live branch.

- [ ] **Step 1: Write a failing test for the pool-direction helper**

The sell needs `tokenIn=RIF`, `tokenOut=WETH`, `fee=poolFee`. Add a pure helper `sellParams(launch, token, amountIn, minOut, recipient, deadline)` and test it:

```js
test('sellParams sells the token FOR weth at the pool fee tier', () => {
  const { sellParams } = require('./sell');
  const p = sellParams(
    { poolFee: 10000n, pairedToken: '0xWeth' },
    '0xRif', 100n, 95n, '0xSeller', 1234n
  );
  assert.strictEqual(p.tokenIn, '0xRif');
  assert.strictEqual(p.tokenOut, '0xWeth');
  assert.strictEqual(p.fee, 10000n);
  assert.strictEqual(p.recipient, '0xSeller');
  assert.strictEqual(p.amountIn, 100n);
  assert.strictEqual(p.amountOutMinimum, 95n);
  assert.strictEqual(p.sqrtPriceLimitX96, 0n);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test src/evm/sell.test.js`
Expected: FAIL — `sellParams` is not exported.

- [ ] **Step 3: Implement `sellParams` and the live branch**

Add the helper and complete `sellTokenForEth`'s live section (replace the `throw new Error('live sell path not implemented yet')`):

```js
/** exactInputSingle params for selling `token` → WETH on the launch pool. */
function sellParams(launch, token, amountIn, minOut, recipient, deadline) {
  return {
    tokenIn: token,
    tokenOut: launch.pairedToken,
    fee: launch.poolFee,
    recipient,
    deadline,
    amountIn: BigInt(amountIn),
    amountOutMinimum: BigInt(minOut),
    sqrtPriceLimitX96: 0n,
  };
}
```

Live branch (after the `if (!sellerSigner) throw ...` guard):

```js
  const launch = await getLaunchedToken(token); // pairedToken (WETH), poolFee
  const router = new Contract(config.swapRouter, V3_ROUTER_ABI, sellerSigner);
  const seller = sellerSigner.address;

  // Approve the router once (idempotent — skip if allowance already covers).
  const rif = erc20(token, sellerSigner);
  const allowance = await rif.allowance(seller, config.swapRouter);
  if (allowance < amount) {
    const approveTx = await sendTx(() => rif.approve(config.swapRouter, MaxUint256));
    await approveTx.wait();
    console.log(`[tx] approve RIF → V3 router: ${approveTx.hash}`);
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  // Quote by static-calling the swap with min=0; refuse if it can't fill.
  const quoted = await router.exactInputSingle.staticCall(
    sellParams(launch, token, amount, 0n, seller, deadline)
  );
  if (quoted === 0n) throw new Error(`sell quote returned 0 (no liquidity for ${token}?)`);
  const minOut = computeMinOut(quoted, config.sellSlippagePct);

  // Swap RIF → WETH; measure WETH actually received from the balance delta.
  const weth = wethContract(sellerSigner);
  const wethBefore = await weth.balanceOf(seller);
  const swapTx = await sendTx(() =>
    router.exactInputSingle(sellParams(launch, token, amount, minOut, seller, deadline))
  );
  await swapTx.wait();
  const wethAfter = await weth.balanceOf(seller);
  const wethOut = wethAfter - wethBefore;
  if (wethOut <= 0n) throw new Error(`sell landed 0 WETH (tx ${swapTx.hash})`);
  console.log(`[tx] sell ${formatUnits(amount, await getDecimals(token))} ${config.tokenSymbol} → ${formatEther(wethOut)} WETH: ${swapTx.hash}`);

  // Unwrap WETH → native ETH in the seller wallet.
  const unwrapTx = await sendTx(() => weth.withdraw(wethOut));
  await unwrapTx.wait();

  // Sweep native ETH to the dev, leaving a gas reserve.
  const balance = await provider.getBalance(seller);
  const value = sweepValue(balance, config.sellerGasReserveEth);
  let ethToDev = 0;
  if (value > 0n) {
    const sweepTx = await sendTx(() => sellerSigner.sendTransaction({ to: config.devWallet, value }));
    await sweepTx.wait();
    ethToDev = Number(formatEther(value));
    console.log(`[tx] forward ${ethToDev} ETH → dev ${config.devWallet}: ${sweepTx.hash}`);
  }

  return {
    signature: swapTx.hash,
    soldRaw: amount,
    sold: Number(formatEther(amount)), // RIF is 18-decimal
    ethReceived: Number(formatEther(wethOut)),
    ethToDev,
    simulated: false,
  };
```

Export `sellParams` in `module.exports`.

- [ ] **Step 4: Run to verify the helper test passes**

Run: `node --test src/evm/sell.test.js`
Expected: PASS (all helper + dry-run tests).

- [ ] **Step 5: Run the full suite (nothing regressed)**

Run: `node --test`
Expected: PASS across all files.

- [ ] **Step 6: Commit**

```bash
git add src/evm/sell.js src/evm/sell.test.js
git commit -m "feat(sell): implement live V3 sell → unwrap → sweep-to-dev path"
```

---

### Task 6: Route-verification probe + disclosure docs

**Files:**
- Create: `scripts/verify-sell-route.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: `config`, `src/evm/pons.js` (`getLaunchedToken`), `src/evm/sell.js` (`sellParams`, `V3_ROUTER_ABI`).
- Produces: an operator-run preflight that confirms the router/pool before any live sell; README disclosure of the mechanism + seller wallet.

- [ ] **Step 1: Write the probe script**

Create `scripts/verify-sell-route.js`:

```js
'use strict';

// Preflight for the dev-fee sell path. Run against the LIVE chain (DRY_RUN=false,
// real TOKEN_ADDRESS + SWAP_ROUTER) to confirm before wiring real funds:
//   - the launch record resolves (pairedToken = WETH, poolFee)
//   - the SWAP_ROUTER's exactInputSingle ABI matches (static-call a tiny sell)
// It sends NOTHING — only static calls. Usage: node scripts/verify-sell-route.js

const { Contract, parseUnits, formatEther } = require('ethers');
const config = require('../src/config');
const { provider } = require('../src/evm/provider');
const { getLaunchedToken } = require('../src/evm/pons');
const { sellParams, V3_ROUTER_ABI } = require('../src/evm/sell');

(async () => {
  if (!config.tokenAddress) throw new Error('TOKEN_ADDRESS required');
  const launch = await getLaunchedToken();
  console.log('launch:', { pairedToken: launch.pairedToken, poolFee: launch.poolFee.toString(), isToken0: launch.isToken0 });
  if (launch.pairedToken.toLowerCase() !== config.weth.toLowerCase()) {
    console.warn('WARN: pairedToken is not WETH — the sell tokenOut assumption is wrong.');
  }
  const router = new Contract(config.swapRouter, V3_ROUTER_ABI, provider);
  const seller = config.sellerAddress || config.wallet.address;
  const amountIn = parseUnits('1', 18); // 1 RIF, static only
  try {
    const out = await router.exactInputSingle.staticCall(
      sellParams(launch, config.tokenAddress, amountIn, 0n, seller, BigInt(Math.floor(Date.now() / 1000) + 600)),
      { from: seller }
    );
    console.log(`OK: exactInputSingle static-call succeeded — 1 RIF → ${formatEther(out)} WETH`);
    console.log('Router ABI matches (SwapRouter with deadline).');
  } catch (err) {
    console.error('FAIL: exactInputSingle static-call reverted:', err.shortMessage || err.message);
    console.error('→ The router may be SwapRouter02 (no deadline in the struct), or 0xCaf6… is not the right router.');
    console.error('  If SwapRouter02: drop `deadline` from V3_ROUTER_ABI and sellParams in src/evm/sell.js.');
  }
})();
```

- [ ] **Step 2: Verify the probe runs (dry, no network needed to load)**

Run: `node -e "require('./scripts/verify-sell-route.js')" 2>&1 | head -5` — it will attempt network calls; against DRY_RUN/no real token it errors out, which is expected. The point is it parses and wires correctly. (Real verification is the operator's job on the live chain.)
Expected: no syntax/require errors; a runtime error about the token/network is fine.

- [ ] **Step 3: Add disclosure to `README.md`**

Find the section describing the burn (search `burn`) and replace/augment it with the honest split description:

```markdown
### Token-side fee: burn + disclosed dev fee

Each cycle, the token-side creator fee (the RIF the wallet receives from
pons.family) is split:

- **`BURN_PCT`% is burned** — sent to the dead address, permanently out of supply.
- **The remainder is sold to ETH** on the RIF/WETH Uniswap V3 launch pool by the
  project's **disclosed fee-conversion wallet** (`SELLER_PRIVATE_KEY`), and the
  ETH is sent to the dev wallet (`DEV_WALLET`).

This is a **disclosed dev fee**, not a burn. The `/v1/stats` endpoint reports
`rifBurned`, `rifSold`, and `ethToDev` separately, and the seller wallet address
is `<PUBLISH THE SELLER ADDRESS HERE>`. The sold portion is never counted as a burn.
```

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-sell-route.js README.md
git commit -m "feat(sell): add route-verification probe + disclose the dev-fee mechanism"
```

---

## Post-implementation (operator, on the live chain — NOT code)

1. Run `node scripts/verify-sell-route.js` with `DRY_RUN=false` + the real `TOKEN_ADDRESS`/`SWAP_ROUTER` to confirm the router ABI. If it reports SwapRouter02, drop `deadline` from `V3_ROUTER_ABI` + `sellParams`.
2. Fund the seller wallet with a little native ETH for gas.
3. Publish the seller wallet address in the README placeholder + anywhere holders are told about the mechanism.
4. Do a small live smoke run (low `BURN_PCT` first cycle) and confirm the `dev-fee` step + `eth_to_dev` land as expected.

## Self-Review

- **Spec coverage:** flow (Task 3) · sell.js module w/ dry-run + live (Tasks 2,5) · config incl. seller wallet/BURN_PCT/DEV_WALLET/slippage/reserve (Task 1) · honest labeling + tokens_burned/tokens_sold/eth_to_dev split in receipts & /v1 (Tasks 3,4) · README disclosure + seller wallet (Task 6) · router-verification check (Task 6) · gas reserve (Tasks 2,5) · reward leg unchanged (Task 3, untouched) · thin-pool slippage floor (Task 5). All spec sections map to a task.
- **Placeholders:** the README `<PUBLISH THE SELLER ADDRESS HERE>` is an intentional operator fill-in (the real address isn't known at build time), called out in Post-implementation step 3 — not a plan gap.
- **Type consistency:** `sellTokenForEth` returns `{signature, soldRaw, sold, ethReceived, ethToDev, simulated}` in both branches and is consumed with those exact names in cycle.js (Task 3). `computeMinOut`/`sweepValue`/`sellParams` signatures match their tests and call sites.

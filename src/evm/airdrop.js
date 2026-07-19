'use strict';

// Airdrop a reward token (PONS) to weighted allocations [{owner, amountRaw}].
// Records every recipient (repo.addAirdrop) so partial failures are visible and
// retriable. Three send paths:
//   - DRY_RUN          → simulate the sends (no chain calls).
//   - DISPERSE_ADDRESS → one tx per batch via a disperse contract
//     (disperseToken(token, recipients[], values[])); the token must be
//     pre-approved to the disperse contract. Fewest txs for very large drops.
//   - otherwise        → sliding-window pipelined ERC-20 transfers: up to
//     AIRDROP_BATCH_SIZE txs stay in flight at once (confirmation happens off the
//     submission path, so the pipeline never idles), the nonce is tracked
//     LOCALLY (fetched once, ++ per send), and gas/fees are fixed — no per-tx
//     estimateGas / fee / nonce round-trips. That is what makes the drop fast and
//     stall-free: reading the nonce per tx from a load-balanced RPC is exactly
//     what caused the stale-nonce failures and the serial slowness.

const { Contract, formatUnits } = require('ethers');
const config = require('../config');
const repo = require('../db/repository');
const { provider, wallet } = require('./provider');
const { erc20, getDecimals } = require('./erc20');
const { sendTx } = require('./send');

const DISPERSE_ABI = ['function disperseToken(address token, address[] recipients, uint256[] values)'];

function chunk(arr, n) {
  const out = [];
  const size = Math.max(1, n | 0);
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

async function airdropToken({ rewardToken, allocations, cycleId }) {
  if (!allocations || allocations.length === 0) return { sent: 0, failed: 0 };

  const decimals = config.dryRun ? 18 : await getDecimals(rewardToken);
  const uiOf = (raw) => Number(formatUnits(BigInt(raw), decimals));
  const record = (a, signature, status) =>
    repo.addAirdrop({
      cycleId,
      rewardToken,
      recipient: a.owner,
      amountRaw: a.amountRaw,
      amountUi: uiOf(a.amountRaw),
      signature,
      status,
    });

  if (config.dryRun) {
    for (const a of allocations) await record(a, fakeSig('airdrop'), 'ok');
    return { sent: allocations.length, failed: 0 };
  }

  if (config.disperseAddress) return disperseAirdrop({ rewardToken, allocations, record });
  return pipelineAirdrop({ rewardToken, allocations, record });
}

// The Disperse contract moves the tokens with transferFrom, so it must be
// approved to spend this reward token. Approve max once per token — after that the
// allowance is huge and this is a no-op. Best-effort: on failure the caller's
// try/catch records the batch failed rather than crashing the cycle.
async function ensureDisperseApproval(token, needed) {
  const t = erc20(token, wallet);
  const allowance = await t.allowance(wallet.address, config.disperseAddress).catch(() => 0n);
  if (allowance >= needed) return;
  const tx = await t.approve(config.disperseAddress, (1n << 256n) - 1n);
  await tx.wait();
  console.log(`[airdrop] approved ${token} → disperse ${config.disperseAddress}: ${tx.hash}`);
}

// One disperseToken tx per batch (nonce-safe via sendTx) — the big win: hundreds
// of recipients paid in a single transaction instead of one tx each. A whole
// batch shares a tx, so a batch either lands for everyone in it or is recorded
// failed together.
async function disperseAirdrop({ rewardToken, allocations, record }) {
  const disperse = new Contract(config.disperseAddress, DISPERSE_ABI, wallet);

  // Approve the disperse contract for the full amount about to be dispersed.
  const total = allocations.reduce((s, a) => s + BigInt(a.amountRaw), 0n);
  try {
    await ensureDisperseApproval(rewardToken, total);
  } catch (err) {
    console.error(`[airdrop] disperse approval failed for ${rewardToken}: ${err.message}`);
    for (const a of allocations) await record(a, null, 'failed');
    return { sent: 0, failed: allocations.length };
  }

  let sent = 0;
  let failed = 0;
  for (const batch of chunk(allocations, config.airdropBatchSize)) {
    const recipients = batch.map((a) => a.owner);
    const values = batch.map((a) => BigInt(a.amountRaw));
    let hash = null;
    let status = 'ok';
    try {
      const tx = await sendTx(() => disperse.disperseToken(rewardToken, recipients, values));
      await tx.wait();
      hash = tx.hash;
    } catch (err) {
      status = 'failed';
      console.error(`[airdrop] disperse batch failed: ${err.message}`);
    }
    for (const a of batch) {
      await record(a, status === 'ok' ? hash : null, status);
      if (status === 'ok') sent += 1;
      else failed += 1;
    }
  }
  return { sent, failed };
}

// Sliding-window pipeline: keep up to AIRDROP_BATCH_SIZE transfers in flight, and
// the moment one confirms, submit the next. Nonce tracked locally; gas/fees fixed.
async function pipelineAirdrop({ rewardToken, allocations, record }) {
  const token = erc20(rewardToken, wallet);
  const windowSize = Math.max(1, config.airdropBatchSize);
  const gasLimit = BigInt(config.airdropGasLimit);
  const total = allocations.length;
  const inFlight = new Set();
  let sent = 0;
  let failed = 0;
  let settled = 0;

  let feeData = await provider.getFeeData();
  let nonce = await provider.getTransactionCount(wallet.address, 'pending');
  const overrides = () => ({
    gasLimit,
    nonce,
    ...(feeData.maxFeePerGas != null
      ? { maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 0n }
      : { gasPrice: feeData.gasPrice }),
  });

  const logProgress = () => {
    if (settled % 50 === 0 || settled === total) {
      console.log(`[airdrop] ${settled}/${total} settled (sent=${sent} failed=${failed})`);
    }
  };

  for (const a of allocations) {
    // Free a slot before submitting the next transfer.
    while (inFlight.size >= windowSize) await Promise.race(inFlight);

    // Submit, retrying once. On failure resync fees AND the nonce from the
    // network — a timed-out send may or may not have consumed the nonce.
    let tx = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 2 && !tx; attempt += 1) {
      try {
        tx = await token.transfer(a.owner, BigInt(a.amountRaw), overrides());
        nonce += 1;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 1500));
        feeData = await provider.getFeeData();
        nonce = await provider.getTransactionCount(wallet.address, 'pending');
      }
    }
    if (!tx) {
      console.error(`[airdrop] transfer to ${a.owner} failed to send: ${lastErr.message}`);
      await record(a, null, 'failed');
      failed += 1;
      settled += 1;
      logProgress();
      continue;
    }

    // Confirmation + DB record happen off the submission path; the loop moves
    // straight on to the next recipient while this one waits for its block.
    const p = (async () => {
      let status = 'ok';
      try {
        await tx.wait();
      } catch (err) {
        status = 'failed';
        console.error(`[airdrop] transfer to ${a.owner} reverted: ${err.message}`);
      }
      await record(a, tx.hash, status);
      if (status === 'ok') sent += 1;
      else failed += 1;
      settled += 1;
      logProgress();
    })().finally(() => inFlight.delete(p));
    inFlight.add(p);
  }

  await Promise.all(inFlight);
  return { sent, failed };
}

module.exports = { airdropToken, chunk };

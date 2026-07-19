'use strict';

const config = require('../config');
const repo = require('../db/repository');
const { parseEther, formatUnits } = require('ethers');
const { claimCreatorFees } = require('../evm/pons');
const { burnToken } = require('../evm/burn');
const { getWethBalanceEth, unwrapAllWeth, getTokenSupplyRaw, readTokenBalance, getDecimals } = require('../evm/erc20');
const { snapshotEligibleHolders } = require('../evm/holders');
const { buildExcludeSet } = require('../evm/exclude');
const { computeWeightedAllocations } = require('../services/distribution');
const { airdropToken } = require('../evm/airdrop');
const { buyReward } = require('../evm/reward');

/**
 * Reward leg: spend `ethAmount` (held as WETH) buying the reward token (PONS) on
 * Uniswap V3, then airdrop it pro-rata to eligible holders of `holderToken`
 * (ponspepe).
 *
 * The holder snapshot is taken ONCE. Only what was actually bought this cycle is
 * distributed (measured from the balance delta), never a holder's own balance.
 *
 * A failed buy (no pool, revert) is recorded and skipped — the cycle still
 * finishes, since the token-side fee burn already happened.
 */
async function runRewardLeg(cycleId, { holderToken, ethAmount, minHold, capPct, clusters }) {
  const log = (m) => console.log(`[cycle ${cycleId}] [reward] ${m}`);

  // Snapshot once.
  const minHoldRaw = (BigInt(Math.trunc(minHold)) * 10n ** 18n).toString(); // ponspepe: 18 decimals
  const exclude = await buildExcludeSet(holderToken);
  const { holders, totalHolders } = await snapshotEligibleHolders({ token: holderToken, minHoldRaw, exclude });
  log(`${holders.length} eligible holders (>= ${minHold}) of ${totalHolders} total`);
  if (!holders.length) {
    log('no eligible holders — skipping the reward buy (nothing to airdrop to)');
    return { sent: 0, failed: 0, eligibleHolders: 0, totalHolders, bought: 0 };
  }

  const supplyRaw = capPct == null ? null : (await getTokenSupplyRaw(holderToken)).toString();
  const rewardWei = parseEther(String(ethAmount));
  const decimals = config.dryRun ? 18 : await getDecimals(config.rewardToken);
  log(`buying ${config.rewardSymbol} with ${ethAmount} WETH on V3`);

  // One buy funds the whole drop. On failure, record it and skip the airdrop.
  let buy;
  try {
    buy = await buyReward(rewardWei);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await repo.addStep({ cycleId, name: 'buy', status: 'failed', detail: { leg: 'reward', token: config.rewardToken, symbol: config.rewardSymbol, message } });
    log(`${config.rewardSymbol} buy SKIPPED — ${message}`);
    return { sent: 0, failed: 0, eligibleHolders: holders.length, totalHolders, bought: 0 };
  }

  const boughtUi = Number(formatUnits(buy.boughtRaw, decimals));
  await repo.addStep({
    cycleId,
    name: 'buy',
    status: 'ok',
    signature: buy.signature,
    detail: { leg: 'reward', token: config.rewardToken, symbol: config.rewardSymbol, ethSpent: Number(formatUnits(rewardWei, 18)), tokensBought: boughtUi },
  });

  const allocations = computeWeightedAllocations(holders, buy.boughtRaw.toString(), { capPct, supplyRaw, clusters });
  const air = await airdropToken({ rewardToken: config.rewardToken, allocations, cycleId });
  await repo.addStep({
    cycleId,
    name: 'airdrop',
    status: air.failed ? 'failed' : 'ok',
    detail: { token: config.rewardToken, symbol: config.rewardSymbol, recipients: allocations.length, sent: air.sent, failed: air.failed },
  });
  log(`${config.rewardSymbol}: bought ${boughtUi} → airdrop sent=${air.sent} failed=${air.failed}`);

  return { sent: air.sent, failed: air.failed, eligibleHolders: holders.length, totalHolders, bought: boughtUi };
}

/**
 * One reward cycle (fired by the scheduler; skipped upstream when nothing is
 * claimable):
 *
 *   claim ponspepe creator fees from the pons.family locker (paid in WETH + the
 *   token itself)
 *     → token-side fee: burned 100% to the dead address (never transferred/sold)
 *     → REWARD_BUY_PCT of the WETH: buy PONS on Uniswap V3 and airdrop it to the
 *                       ponspepe holders (pro-rata)
 *     → remainder:      unwrapped to native ETH (dev cut + gas)
 *
 * Each step is recorded; a thrown step fails the cycle without crashing.
 * @returns {Promise<object>} the persisted cycle (with steps)
 */
async function runCycle() {
  const id = await repo.createCycle({ dryRun: config.dryRun });
  const log = (msg) => console.log(`[cycle ${id}] ${msg}`);

  try {
    if (!config.tokenAddress) throw new Error('TOKEN_ADDRESS (PONZI) is required');

    // 1. Claim creator fees. pons pays them in WETH + the token itself (ponspepe),
    //    so after this both land in the wallet.
    const claim = await claimCreatorFees();
    await repo.addStep({ cycleId: id, name: 'claim', status: 'ok', signature: claim.signature, detail: { ethClaimed: claim.ethClaimed } });
    log(`claimed ${claim.ethClaimed} ETH`);

    // 2. Burn the wallet's ENTIRE token-side fee to the dead address. The token
    //    fee is never transferred to another wallet and never sold — 100% of it
    //    is burned. Best-effort: a failure here must never strand the reward
    //    airdrop. NOTE: this consumes ALL ponspepe the operating wallet holds, so
    //    do not park any there.
    let burned = 0;
    let burnSig = null;
    // Kept at zero so historical cycles and the public API keep their shape.
    // Nothing is sold or forwarded to a dev wallet any more.
    const sold = 0;
    const ethToDev = 0;
    const devFeeSig = null;
    const feeBalRaw = config.dryRun
      ? 10n ** 21n // simulate ~1000 ponspepe so a dry cycle exercises the burn
      : await readTokenBalance(config.tokenAddress, config.wallet.address).catch(() => 0n);
    if (feeBalRaw > 0n) {
      try {
        const burn = await burnToken(config.tokenAddress, feeBalRaw.toString());
        await repo.addStep({ cycleId: id, name: 'burn', status: 'ok', signature: burn.signature, detail: { token: config.tokenAddress, tokensBurned: burn.burned, burnedRaw: burn.burnedRaw, deadAddress: burn.deadAddress, pct: 100 } });
        burned = burn.burned;
        burnSig = burn.signature;
        log(`burned ${burn.burned} ${config.tokenSymbol} (100%) → ${burn.deadAddress}`);
      } catch (err) {
        await repo.addStep({ cycleId: id, name: 'burn', status: 'failed', detail: { message: err.message } });
        log(`burn ${config.tokenSymbol} failed (non-fatal): ${err.message}`);
      }
    }

    // Spend the wallet's WHOLE WETH balance (this claim plus any residue). In
    // DRY_RUN there is no real WETH, so use the simulated claim amount.
    const claimed = claim.ethClaimed;
    const walletWeth = config.dryRun ? claimed : await getWethBalanceEth().catch(() => claimed);
    if (!(walletWeth > 0)) {
      await repo.finishCycle(id, { status: 'skipped', eth_claimed: claimed, tokens_burned: burned, tokens_sold: sold, eth_to_dev: ethToDev, burn_sig: burnSig, dev_fee_sig: devFeeSig, note: 'nothing claimed (WETH)' });
      log('skipped: no WETH to buy the reward (ponspepe fee still burned)');
      return repo.getCycleWithSteps(id);
    }

    // Do NOT unwrap here: the reward buy swaps WETH → PONS directly on V3, so the
    // claim stays as WETH. Only the dev remainder is unwrapped to native ETH below.
    const rewardEth = +(walletWeth * (config.rewardBuyPct / 100)).toFixed(9);
    const devEth = +(walletWeth - rewardEth).toFixed(9);
    log(`split: ${rewardEth} → ${config.rewardSymbol} (${config.rewardBuyPct}%), keep ${devEth} for dev/gas (${config.devPct}%)`);

    // 2. Reward leg — buy PONS on V3 + airdrop it to ponspepe holders.
    let reward = { sent: 0, failed: 0, eligibleHolders: 0, totalHolders: 0, bought: 0 };
    if (rewardEth > 0) {
      reward = await runRewardLeg(id, {
        holderToken: config.tokenAddress,
        ethAmount: rewardEth,
        minHold: config.minHold,
        capPct: config.rewardCapPct > 0 ? config.rewardCapPct : null,
        clusters: config.clusters,
      });
    }

    // 3. Dev cut — unwrap the remaining WETH (the dev portion, plus any residue or
    //    a claim that arrived mid-cycle) to native ETH. Best-effort — never fails
    //    the cycle.
    await unwrapAllWeth().catch((err) => log(`unwrap remainder failed (non-fatal): ${err.message}`));

    // 4. Done.
    await repo.finishCycle(id, {
      status: 'complete',
      mode: 'pons-reward',
      eth_claimed: claimed,
      eth_spent_buy: rewardEth,
      tokens_bought: reward.bought,
      tokens_burned: burned,
      tokens_sold: sold,
      eth_to_dev: ethToDev,
      burn_sig: burnSig,
      dev_fee_sig: devFeeSig,
      eligible_holders: reward.eligibleHolders,
      total_holders: reward.totalHolders,
      note: `burned ${burned} ${config.tokenSymbol} (100%); bought ${reward.bought} ${config.rewardSymbol}, airdropped to ${reward.sent} (${reward.failed} failed)`,
    });
    log('complete (pons-reward)');
    return repo.getCycleWithSteps(id);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await repo.addStep({ cycleId: id, name: 'error', status: 'failed', detail: { message } });
    await repo.finishCycle(id, { status: 'failed', error: message });
    log(`FAILED: ${message}`);
    return repo.getCycleWithSteps(id);
  }
}

module.exports = { runCycle, runRewardLeg };

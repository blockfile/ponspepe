'use strict';

const config = require('../config');
const repo = require('../db/repository');
const { parseEther, formatUnits } = require('ethers');
const { claimCreatorFees } = require('../evm/pons');
const { burnToken } = require('../evm/burn');
const { sellTokenForEth } = require('../evm/sell');
const { getWethBalanceEth, unwrapAllWeth, getTokenSupplyRaw, readTokenBalance } = require('../evm/erc20');
const { snapshotEligibleHolders } = require('../evm/holders');
const { buildExcludeSet } = require('../evm/exclude');
const { computeWeightedAllocations } = require('../services/distribution');
const { airdropToken } = require('../evm/airdrop');
const { resolveStocks } = require('../evm/stocks');
const { buyStockWithEth } = require('../evm/v4');

/**
 * Reward leg: split `ethAmount` across the configured stocks, buy each on
 * Uniswap V4 with native ETH, and airdrop each stock pro-rata to eligible
 * holders of `holderToken` (PONZI).
 *
 * The holder snapshot is taken ONCE and reused for every stock, so all stocks
 * use identical weights and a holder can't shift their share between drops.
 * Only what was actually bought this cycle is distributed (measured from the
 * balance delta), never a holder's own balance.
 *
 * A stock that fails (no pool, revert) is recorded and skipped — one bad stock
 * must not cost the others their airdrop.
 */
async function runRewardLeg(cycleId, { holderToken, ethAmount, minHold, capPct, clusters }) {
  const log = (m) => console.log(`[cycle ${cycleId}] [reward] ${m}`);

  const stocks = resolveStocks(config.stocks);
  if (!stocks.length) throw new Error('no stocks configured');

  // Snapshot once; every stock is weighted identically off it.
  const minHoldRaw = (BigInt(Math.trunc(minHold)) * 10n ** 18n).toString(); // PONZI: 18 decimals
  const exclude = await buildExcludeSet(holderToken);
  const { holders, totalHolders } = await snapshotEligibleHolders({ token: holderToken, minHoldRaw, exclude });
  log(`${holders.length} eligible holders (>= ${minHold}) of ${totalHolders} total`);
  if (!holders.length) {
    log('no eligible holders — skipping the stock buys (nothing to airdrop to)');
    return { sent: 0, failed: 0, eligibleHolders: 0, totalHolders, stocks: [] };
  }

  const supplyRaw = capPct == null ? null : (await getTokenSupplyRaw(holderToken)).toString();
  const perStockWei = parseEther(String(ethAmount)) / BigInt(stocks.length);
  log(`buying ${stocks.length} stocks with ${ethAmount} ETH (${formatUnits(perStockWei, 18)} each): ${stocks.map((s) => s.symbol).join(', ')}`);

  let sent = 0;
  let failed = 0;
  const results = [];

  for (const stock of stocks) {
    try {
      const buy = await buyStockWithEth(stock, perStockWei);
      const boughtUi = Number(formatUnits(buy.boughtRaw, stock.decimals));
      await repo.addStep({
        cycleId,
        name: 'buy',
        status: 'ok',
        signature: buy.signature,
        detail: { leg: 'reward', stock: stock.symbol, token: stock.token, ethSpent: Number(formatUnits(perStockWei, 18)), tokensBought: boughtUi },
      });

      const allocations = computeWeightedAllocations(holders, buy.boughtRaw.toString(), { capPct, supplyRaw, clusters });
      const air = await airdropToken({ rewardToken: stock.token, allocations, cycleId });
      await repo.addStep({
        cycleId,
        name: 'airdrop',
        status: air.failed ? 'failed' : 'ok',
        detail: { stock: stock.symbol, token: stock.token, recipients: allocations.length, sent: air.sent, failed: air.failed },
      });
      sent += air.sent;
      failed += air.failed;
      results.push({ symbol: stock.symbol, bought: boughtUi, sent: air.sent, failed: air.failed });
      log(`${stock.symbol}: bought ${boughtUi} → airdrop sent=${air.sent} failed=${air.failed}`);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      await repo.addStep({ cycleId, name: 'buy', status: 'failed', detail: { leg: 'reward', stock: stock.symbol, token: stock.token, message } });
      results.push({ symbol: stock.symbol, error: message });
      log(`${stock.symbol}: SKIPPED — ${message}`);
    }
  }

  return { sent, failed, eligibleHolders: holders.length, totalHolders, stocks: results };
}

/**
 * One reward cycle (fired by the scheduler; skipped upstream when nothing is
 * claimable):
 *
 *   claim PONZI creator fees from the pons.family locker (paid in WETH)
 *     → unwrap to native ETH (the V4 stock pools price against native ETH)
 *     → REWARD_BUY_PCT: buy the stocks on Uniswap V4 and airdrop each to PONZI
 *                       holders (pro-rata)
 *     → remainder:      kept as native ETH (dev cut + gas)
 *
 * Each step is recorded; a thrown step fails the cycle without crashing.
 * @returns {Promise<object>} the persisted cycle (with steps)
 */
async function runCycle() {
  const id = await repo.createCycle({ dryRun: config.dryRun });
  const log = (msg) => console.log(`[cycle ${id}] ${msg}`);

  try {
    if (!config.tokenAddress) throw new Error('TOKEN_ADDRESS (PONZI) is required');

    // 1. Claim creator fees. pons pays them in WETH + the token itself (RIF), so
    //    after this both land in the wallet.
    const claim = await claimCreatorFees();
    await repo.addStep({ cycleId: id, name: 'claim', status: 'ok', signature: claim.signature, detail: { ethClaimed: claim.ethClaimed } });
    log(`claimed ${claim.ethClaimed} ETH`);

    // 2. Split the wallet's token-side fee. Burn BURN_PCT to the dead address;
    //    sell the remainder to ETH from the DISCLOSED seller wallet and send the
    //    ETH to the dev. Both legs are best-effort — a failure here must never
    //    strand the stock airdrops. The sell is NEVER labeled a burn. NOTE: this
    //    consumes ALL RIF in the operating wallet, so do not park RIF here.
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

    // Spend the wallet's WHOLE WETH balance (this claim plus any residue). In
    // DRY_RUN there is no real WETH, so use the simulated claim amount.
    const claimed = claim.ethClaimed;
    const walletWeth = config.dryRun ? claimed : await getWethBalanceEth().catch(() => claimed);
    if (!(walletWeth > 0)) {
      await repo.finishCycle(id, { status: 'skipped', eth_claimed: claimed, tokens_burned: burned, tokens_sold: sold, eth_to_dev: ethToDev, burn_sig: burnSig, dev_fee_sig: devFeeSig, note: 'nothing claimed (WETH)' });
      log('skipped: no WETH to buy stocks (RIF fee still burned + sold)');
      return repo.getCycleWithSteps(id);
    }

    // The claim lands as WETH, but the V4 stock pools price against NATIVE ETH —
    // so unwrap the whole claim up front and spend ETH directly.
    if (!config.dryRun) {
      await unwrapAllWeth().catch((err) => log(`unwrap before stock buys failed (non-fatal): ${err.message}`));
    }

    const rewardEth = +(walletWeth * (config.rewardBuyPct / 100)).toFixed(9);
    const devEth = +(walletWeth - rewardEth).toFixed(9);
    log(`split: ${rewardEth} → stocks (${config.rewardBuyPct}%), keep ${devEth} for dev/gas (${config.devPct}%)`);

    // 2. Reward leg — buy stocks on V4 + airdrop each to PONZI holders.
    let reward = { sent: 0, failed: 0, eligibleHolders: 0, totalHolders: 0, stocks: [] };
    if (rewardEth > 0) {
      reward = await runRewardLeg(id, {
        holderToken: config.tokenAddress,
        ethAmount: rewardEth,
        minHold: config.minHold,
        capPct: config.rewardCapPct > 0 ? config.rewardCapPct : null,
        clusters: config.clusters,
      });
    }

    // 3. Dev cut — sweep any WETH left over (e.g. a claim that arrived after the
    //    unwrap) to native ETH. Best-effort — never fails the cycle.
    await unwrapAllWeth().catch((err) => log(`unwrap remainder failed (non-fatal): ${err.message}`));

    // 4. Done.
    await repo.finishCycle(id, {
      status: 'complete',
      mode: 'stocks-reward',
      eth_claimed: claimed,
      eth_spent_buy: rewardEth,
      tokens_burned: burned,
      tokens_sold: sold,
      eth_to_dev: ethToDev,
      burn_sig: burnSig,
      dev_fee_sig: devFeeSig,
      eligible_holders: reward.eligibleHolders,
      total_holders: reward.totalHolders,
      stocks: reward.stocks,
      note: `burned ${burned} + sold ${sold} ${config.tokenSymbol} (→ ${ethToDev} ETH dev); airdropped ${reward.stocks.filter((s) => !s.error).length} stocks, ${reward.sent} sends (${reward.failed} failed)`,
    });
    log('complete (stocks-reward)');
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

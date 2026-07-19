'use strict';

// Buy the reward token (PONS) with WETH on Uniswap V3, so it can be airdropped to
// the ponspepe holders.
//
// PONS has NO native-ETH V4 pool (unlike the Robinhood stock tokens), and it is
// not a pons.family launch — its liquidity is a plain PONS/WETH Uniswap V3 pool
// (the deep one is the 1% fee tier; verified on-chain). So we keep the fee claim
// as WETH (no unwrap) and swap WETH → PONS directly through the same V3
// SwapRouter02 the fee-sell uses (config.swapRouter), at config.rewardPoolFee.
//
// The received amount is measured from the wallet's balance delta — never trusted
// from the router's return value — so a fee-on-transfer or partial fill can't
// overstate the airdrop.

const { Contract, MaxUint256, formatEther, formatUnits } = require('ethers');
const config = require('../config');
const { wallet } = require('./provider');
const { wethContract, readTokenBalance, getDecimals } = require('./erc20');
const { sendTx } = require('./send');

// SwapRouter02 exactInputSingle — the struct has NO `deadline` field (that's the
// classic SwapRouter). Using the with-deadline signature reverts bare against
// SwapRouter02 — the failure diagnosed for the fee-sell on 2026-07-18. The swap
// is sent immediately; the slippage floor is the protection.
const V3_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
];

/** Slippage floor: quotedRaw * (100 - slippagePct)%, in basis points. */
function computeMinOut(quotedRaw, slippagePct) {
  return (BigInt(quotedRaw) * BigInt(Math.round((100 - slippagePct) * 100))) / 10000n;
}

/** SwapRouter02 exactInputSingle params for buying the reward token with WETH. */
function buyParams(amountIn, minOut, recipient) {
  return {
    tokenIn: config.weth,
    tokenOut: config.rewardToken,
    fee: config.rewardPoolFee,
    recipient,
    amountIn: BigInt(amountIn),
    amountOutMinimum: BigInt(minOut),
    sqrtPriceLimitX96: 0n,
  };
}

function fakeSig() {
  return `buy_${config.rewardSymbol}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Buy the reward token with `amountWethRaw` of WETH through the V3 SwapRouter02,
 * received to the operating wallet. Returns the amount actually bought (balance
 * delta). Throws if the pool can't fill — the caller records the buy failed and
 * skips the airdrop rather than crashing the cycle.
 * @returns {Promise<{signature, boughtRaw: bigint, quotedRaw: bigint, simulated: boolean}>}
 */
async function buyReward(amountWethRaw) {
  const amount = BigInt(amountWethRaw || '0');

  if (config.dryRun) {
    // Simulate ~100k PONS per WETH (near the live pool mid) so a dry cycle has
    // something to allocate.
    const boughtRaw = amount * 100000n;
    return { signature: fakeSig(), boughtRaw, quotedRaw: boughtRaw, simulated: true };
  }

  if (amount <= 0n) throw new Error('invalid reward buy amount');

  const me = wallet.address;

  // Approve WETH → router once (idempotent — skip if the allowance already covers).
  const weth = wethContract(wallet);
  const allowance = await weth.allowance(me, config.swapRouter).catch(() => 0n);
  if (allowance < amount) {
    const approveTx = await sendTx(() => weth.approve(config.swapRouter, MaxUint256));
    await approveTx.wait();
    console.log(`[tx] approve WETH → V3 router: ${approveTx.hash}`);
  }

  const router = new Contract(config.swapRouter, V3_ROUTER_ABI, wallet);

  // Quote by static-calling the swap with min=0; refuse if it can't fill.
  const quoted = await router.exactInputSingle.staticCall(buyParams(amount, 0n, me));
  if (quoted === 0n) throw new Error(`reward buy quote returned 0 (no liquidity for ${config.rewardSymbol}?)`);
  const minOut = computeMinOut(quoted, config.slippagePct);

  // Swap WETH → PONS; measure PONS actually received from the balance delta.
  const before = await readTokenBalance(config.rewardToken, me);
  const tx = await sendTx(() => router.exactInputSingle(buyParams(amount, minOut, me)));
  await tx.wait();
  const after = await readTokenBalance(config.rewardToken, me);

  const boughtRaw = after - before;
  if (boughtRaw <= 0n) throw new Error(`reward buy landed 0 ${config.rewardSymbol} (tx ${tx.hash})`);

  console.log(
    `[tx] buy ${formatUnits(boughtRaw, await getDecimals(config.rewardToken))} ${config.rewardSymbol} ` +
      `with ${formatEther(amount)} WETH (V3): ${tx.hash}`
  );
  return { signature: tx.hash, boughtRaw, quotedRaw: quoted, simulated: false };
}

module.exports = { computeMinOut, buyParams, buyReward, V3_ROUTER_ABI };

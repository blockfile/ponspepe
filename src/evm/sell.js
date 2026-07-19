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
const { provider, wallet } = require('./provider');
const { erc20, wethContract, getDecimals, readTokenBalance } = require('./erc20');
const { getLaunchedToken } = require('./pons');
const { sendTx } = require('./send');

// Uniswap V3 SwapRouter02 — the router deployed on Robinhood Chain
// (0xCaf6…, verified). SwapRouter02's exactInputSingle struct has NO `deadline`
// (that's the classic SwapRouter). Using the with-deadline signature makes the
// calldata hit a nonexistent function and revert bare — the failure diagnosed on
// 2026-07-18. Deadline is dropped entirely (the swap is sent immediately; the
// slippage floor is the protection).
const V3_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
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

/** SwapRouter02 exactInputSingle params for selling `token` → WETH on the pool. */
function sellParams(launch, token, amountIn, minOut, recipient) {
  return {
    tokenIn: token,
    tokenOut: launch.pairedToken,
    fee: launch.poolFee,
    recipient,
    amountIn: BigInt(amountIn),
    amountOutMinimum: BigInt(minOut),
    sqrtPriceLimitX96: 0n,
  };
}

const sellerSigner = config.sellerWallet ? config.sellerWallet.connect(provider) : null;

function fakeSig() {
  return `sell_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Sell `amountRaw` of `token` to ETH from the seller wallet and forward the ETH
 * to config.devWallet. Best-effort caller handles failures.
 * @returns {Promise<{signature, soldRaw: bigint, sold: number, ethReceived: number, ethToDev: number, simulated: boolean}>}
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

  const launch = await getLaunchedToken(token); // pairedToken (WETH), poolFee
  const router = new Contract(config.swapRouter, V3_ROUTER_ABI, sellerSigner);
  const seller = sellerSigner.address;

  // Move the sell-side RIF from the operating wallet to the DISCLOSED seller
  // wallet FIRST, so the swap is signed by (and visible on-chain as) the seller
  // wallet — the point of the separate wallet.
  const xferTx = await sendTx(() => erc20(token, wallet).transfer(seller, amount));
  await xferTx.wait();
  console.log(`[tx] move ${formatEther(amount)} ${config.tokenSymbol} → seller ${seller}: ${xferTx.hash}`);

  // Sell the seller wallet's FULL RIF balance (this transfer plus any residue
  // stranded by an earlier cycle whose sell failed) — self-healing.
  const sellAmount = await readTokenBalance(token, seller);
  if (sellAmount <= 0n) throw new Error('seller wallet holds no RIF after transfer');

  // Approve the router once (idempotent — skip if the allowance already covers).
  const rif = erc20(token, sellerSigner);
  const allowance = await rif.allowance(seller, config.swapRouter);
  if (allowance < sellAmount) {
    const approveTx = await sendTx(() => rif.approve(config.swapRouter, MaxUint256));
    await approveTx.wait();
    console.log(`[tx] approve ${config.tokenSymbol} → V3 router: ${approveTx.hash}`);
  }

  // Quote by static-calling the swap with min=0; refuse if it can't fill.
  const quoted = await router.exactInputSingle.staticCall(
    sellParams(launch, token, sellAmount, 0n, seller)
  );
  if (quoted === 0n) throw new Error(`sell quote returned 0 (no liquidity for ${token}?)`);
  const minOut = computeMinOut(quoted, config.sellSlippagePct);

  // Swap RIF → WETH; measure WETH actually received from the balance delta.
  const weth = wethContract(sellerSigner);
  const wethBefore = await weth.balanceOf(seller);
  const swapTx = await sendTx(() =>
    router.exactInputSingle(sellParams(launch, token, sellAmount, minOut, seller))
  );
  await swapTx.wait();
  const wethAfter = await weth.balanceOf(seller);
  const wethOut = wethAfter - wethBefore;
  if (wethOut <= 0n) throw new Error(`sell landed 0 WETH (tx ${swapTx.hash})`);
  console.log(`[tx] sell ${formatUnits(sellAmount, await getDecimals(token))} ${config.tokenSymbol} → ${formatEther(wethOut)} WETH: ${swapTx.hash}`);

  // Unwrap WETH → native ETH in the seller wallet.
  const unwrapTx = await sendTx(() => weth.withdraw(wethOut));
  await unwrapTx.wait();

  // Sweep native ETH to the dev, leaving a gas reserve for the next cycle.
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
    soldRaw: sellAmount,
    sold: Number(formatEther(sellAmount)), // RIF is 18-decimal
    ethReceived: Number(formatEther(wethOut)),
    ethToDev,
    simulated: false,
  };
}

module.exports = { computeMinOut, sweepValue, sellParams, sellTokenForEth, sellerSigner, V3_ROUTER_ABI };

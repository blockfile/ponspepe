'use strict';

// Buying Robinhood stock tokens on Uniswap V4 with native ETH.
//
// Why V4 and not V2/V3: on Robinhood Chain the stock tokens have NO V2 pairs,
// and their V3 pools exist but are all empty (liquidity = 0). The real liquidity
// lives in the V4 singleton PoolManager. Verified on-chain.
//
// V4 can't be swapped by an EOA directly — the PoolManager uses an unlock/callback
// flow — so swaps go through the UniversalRouter, which encodes a V4_SWAP command
// carrying (actions, params). Pricing comes from V4Quoter (non-view; eth_call it).
//
// Each stock pools directly against NATIVE ETH (currency0 = address(0)), so there
// is no wrapping and no USDG hop.

const { Contract, AbiCoder, concat, ZeroAddress, formatEther, formatUnits } = require('ethers');
const config = require('../config');
const { provider, wallet } = require('./provider');
const { readTokenBalance } = require('./erc20');
const { getEthPriceUsd } = require('./price');

const abi = AbiCoder.defaultAbiCoder();

// UniversalRouter command
const CMD_V4_SWAP = '0x10';
// v4-periphery Actions
const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
const ACT_SETTLE_ALL = 0x0c;
const ACT_TAKE_ALL = 0x0f;

const POOL_KEY_T = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const EXACT_IN_SINGLE_T = `(${POOL_KEY_T} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`;

const ROUTER_ABI = ['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'];
const QUOTER_ABI = [
  `function quoteExactInputSingle((${POOL_KEY_T} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)`,
];

/**
 * The V4 PoolKey for a native-ETH/stock pool. Native ETH is address(0), which
 * always sorts first, so currency0 is always native and zeroForOne is always true
 * when buying the stock.
 */
function ethPoolKey(stock) {
  return {
    currency0: ZeroAddress,
    currency1: stock.token,
    fee: stock.fee,
    tickSpacing: stock.tickSpacing,
    hooks: stock.hooks || ZeroAddress,
  };
}

/**
 * Quote ETH → stock without sending anything. V4Quoter is intentionally
 * non-view (it simulates the swap), so it must be eth_call'd, not read.
 * @returns {Promise<bigint|null>} expected stock out, or null if there's no pool
 */
async function quoteEthToStock(stock, amountInWei) {
  const quoter = new Contract(config.v4Quoter, QUOTER_ABI, provider);
  try {
    const [amountOut] = await quoter.quoteExactInputSingle.staticCall({
      poolKey: ethPoolKey(stock),
      zeroForOne: true,
      exactAmount: amountInWei,
      hookData: '0x',
    });
    return amountOut;
  } catch (_err) {
    return null; // no pool / no liquidity for this stock against native ETH
  }
}

/**
 * Refuse to buy through a pool whose price is nonsense.
 *
 * This is not hypothetical: on this chain the TSM and AVGO pools are initialised
 * but empty, and quote 0.01 ETH → ~0.0000001 units — an implied ~$179,000,000
 * per share against a real price of ~$408. The slippage floor CANNOT catch that,
 * because amountOutMinimum is derived from the same poisoned quote. So sanity
 * check the implied unit price against the live ETH price and skip the stock.
 *
 * If the ETH price is unavailable we don't block the cycle — the per-stock
 * try/catch and the slippage floor still apply.
 */
async function assertSanePrice(stock, amountInWei, quotedRaw) {
  const ethUsd = await getEthPriceUsd().catch(() => null);
  if (!ethUsd || !(ethUsd > 0)) return null;

  const units = Number(formatUnits(quotedRaw, stock.decimals));
  if (!(units > 0)) throw new Error(`${stock.symbol}: quote returned 0 units`);

  const impliedUsd = (Number(formatEther(amountInWei)) * ethUsd) / units;
  if (impliedUsd > config.maxImpliedPriceUsd || impliedUsd < config.minImpliedPriceUsd) {
    throw new Error(
      `${stock.symbol} pool looks broken — implied $${impliedUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}/unit ` +
        `outside the sane range $${config.minImpliedPriceUsd}–$${config.maxImpliedPriceUsd}; refusing to buy`
    );
  }
  return impliedUsd;
}

/** Encode the UniversalRouter input for a single exact-in V4 swap. */
function encodeSwapInput({ poolKey, zeroForOne, amountIn, amountOutMin, currencyIn, currencyOut }) {
  const actions = concat([Uint8Array.from([ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL])]);
  const params = [
    abi.encode(
      [EXACT_IN_SINGLE_T],
      [[[poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks], zeroForOne, amountIn, amountOutMin, '0x']]
    ),
    abi.encode(['address', 'uint256'], [currencyIn, amountIn]), // SETTLE_ALL — pay the input
    abi.encode(['address', 'uint256'], [currencyOut, amountOutMin]), // TAKE_ALL — receive the output
  ];
  return abi.encode(['bytes', 'bytes[]'], [actions, params]);
}

/** Build the exact execute() args for an ETH → stock buy (also used to simulate). */
function buildBuyCall(stock, amountInWei, amountOutMin) {
  const input = encodeSwapInput({
    poolKey: ethPoolKey(stock),
    zeroForOne: true,
    amountIn: amountInWei,
    amountOutMin,
    currencyIn: ZeroAddress, // native ETH in
    currencyOut: stock.token,
  });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  return { commands: CMD_V4_SWAP, inputs: [input], deadline, value: amountInWei };
}

/**
 * Simulate the buy without sending it — proves the encoding and the pool before
 * any funds move. Returns the revert reason instead of throwing.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function simulateBuy(stock, amountInWei, amountOutMin = 0n, from = wallet.address) {
  const { commands, inputs, deadline, value } = buildBuyCall(stock, amountInWei, amountOutMin);
  const router = new Contract(config.universalRouter, ROUTER_ABI, provider);
  try {
    await router.execute.staticCall(commands, inputs, deadline, { from, value });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.shortMessage || err.reason || err.message };
  }
}

/**
 * Buy `stock` with `amountInWei` of NATIVE ETH through the UniversalRouter.
 * The received amount is measured from the balance delta — never trusted from
 * the router — so a fee-on-transfer or partial fill can't overstate the airdrop.
 * @returns {Promise<{signature, boughtRaw, quotedRaw, simulated}>}
 */
async function buyStockWithEth(stock, amountInWei) {
  if (amountInWei <= 0n) throw new Error(`invalid buy amount for ${stock.symbol}`);

  if (config.dryRun) {
    // Simulate ~5 stock units per ETH so a dry cycle has something to allocate.
    const boughtRaw = (amountInWei * 5n) / 1n;
    return { signature: `buy_${stock.symbol}_${Date.now().toString(36)}`, boughtRaw, quotedRaw: boughtRaw, simulated: true };
  }

  const quoted = await quoteEthToStock(stock, amountInWei);
  if (quoted == null || quoted === 0n) {
    throw new Error(`no V4 ETH pool/liquidity for ${stock.symbol} (${stock.token})`);
  }
  // Guard against an initialised-but-empty pool quoting absurd prices — the
  // slippage floor can't, since it's derived from this same quote.
  await assertSanePrice(stock, amountInWei, quoted);

  const amountOutMin = (quoted * BigInt(Math.round((100 - config.slippagePct) * 100))) / 10000n;

  const { commands, inputs, deadline, value } = buildBuyCall(stock, amountInWei, amountOutMin);
  const router = new Contract(config.universalRouter, ROUTER_ABI, wallet);

  const before = await readTokenBalance(stock.token, wallet.address);
  const tx = await router.execute(commands, inputs, deadline, { value });
  await tx.wait();
  const after = await readTokenBalance(stock.token, wallet.address);

  const boughtRaw = after - before;
  if (boughtRaw <= 0n) throw new Error(`${stock.symbol} buy landed 0 tokens (tx ${tx.hash})`);

  console.log(`[tx] buy ${stock.symbol} with ${amountInWei} wei ETH (V4): ${tx.hash}`);
  return { signature: tx.hash, boughtRaw, quotedRaw: quoted, simulated: false };
}

module.exports = {
  ethPoolKey,
  quoteEthToStock,
  assertSanePrice,
  encodeSwapInput,
  buildBuyCall,
  simulateBuy,
  buyStockWithEth,
  CMD_V4_SWAP,
};

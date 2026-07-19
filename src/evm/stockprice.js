'use strict';

// Live USD prices for the stock tokens, read straight from their Uniswap V4
// pools. We read the pool's current sqrtPrice (StateView.getSlot0) rather than
// quoting a swap, so the price is the pool MID — not inflated by the 5% swap fee
// a quote would carry — then convert to USD via the ETH price.
//
// Each stock pools directly against native ETH, and address(0) (native) always
// sorts first, so currency0 = ETH and currency1 = the stock. From sqrtPriceX96:
//   (sqrtPriceX96 / 2^96)^2  =  stock units per 1 ETH   (both are 18 decimals)
// invert for ETH per stock, times the ETH price for USD.

const { Contract, AbiCoder, keccak256, ZeroAddress } = require('ethers');
const config = require('../config');
const { provider } = require('./provider');
const { getEthPriceUsd } = require('./price');
const { REGISTRY } = require('./stocks');

const STATE_VIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
];
const abi = AbiCoder.defaultAbiCoder();

/** V4 pool id for a stock's native-ETH pool. */
function poolIdFor(stock) {
  return keccak256(
    abi.encode(
      ['(address,address,uint24,int24,address)'],
      [[ZeroAddress, stock.token, stock.fee, stock.tickSpacing, stock.hooks || ZeroAddress]]
    )
  );
}

/**
 * ETH per 1 stock from the pool's sqrtPriceX96. token0 = ETH, token1 = stock, so
 * (sqrtP/2^96)^2 is stock-per-ETH; invert. Uses float for the sqrt ratio (~2.9),
 * which keeps ~15 significant digits — ample for a display price.
 */
function ethPerStockFromSqrt(sqrtPriceX96) {
  const sqrtP = Number(sqrtPriceX96) / 2 ** 96; // sqrt(stock per ETH)
  const stockPerEth = sqrtP * sqrtP;
  if (!(stockPerEth > 0)) return null;
  return 1 / stockPerEth;
}

const TTL_MS = 30_000;
let cache = { value: {}, at: 0 };

/**
 * { SYMBOL: priceUsd|null } for every stock in the registry, cached ~30s. A pool
 * that can't be read (or no ETH price) yields null for that symbol rather than
 * failing the whole map.
 */
async function getStockPricesUsd() {
  const now = Date.now();
  if (cache.at !== 0 && now - cache.at < TTL_MS) return cache.value;

  const ethUsd = await getEthPriceUsd().catch(() => null);
  const sv = new Contract(config.v4StateView, STATE_VIEW_ABI, provider);

  const entries = await Promise.all(
    REGISTRY.map(async (s) => {
      try {
        const [sqrtPriceX96] = await sv.getSlot0(poolIdFor(s));
        const ethPer = ethPerStockFromSqrt(sqrtPriceX96);
        const usd = ethPer != null && ethUsd ? +(ethPer * ethUsd).toFixed(2) : null;
        return [s.symbol, usd];
      } catch {
        return [s.symbol, null];
      }
    })
  );

  cache = { value: Object.fromEntries(entries), at: now };
  return cache.value;
}

module.exports = { getStockPricesUsd, poolIdFor, ethPerStockFromSqrt };

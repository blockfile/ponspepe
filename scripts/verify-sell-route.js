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
  console.log('launch:', {
    pairedToken: launch.pairedToken,
    poolFee: launch.poolFee.toString(),
    isToken0: launch.isToken0,
  });
  if (launch.pairedToken.toLowerCase() !== config.weth.toLowerCase()) {
    console.warn('WARN: pairedToken is not WETH — the sell tokenOut assumption is wrong.');
  }

  const router = new Contract(config.swapRouter, V3_ROUTER_ABI, provider);
  const seller = config.sellerAddress || config.wallet.address;
  const amountIn = parseUnits('1', 18); // 1 RIF, static only
  try {
    const out = await router.exactInputSingle.staticCall(
      sellParams(launch, config.tokenAddress, amountIn, 0n, seller),
      { from: seller }
    );
    console.log(`OK: exactInputSingle static-call succeeded — 1 RIF → ${formatEther(out)} WETH`);
    console.log('Router ABI matches (SwapRouter02 — no deadline).');
  } catch (err) {
    console.error('FAIL: exactInputSingle static-call reverted:', err.shortMessage || err.message);
    console.error('→ Confirm 0xCaf6… is SwapRouter02 (exactInputSingle WITHOUT deadline) and that the');
    console.error('  seller address holds RIF (the quote pulls via transferFrom during simulation).');
  }
})();

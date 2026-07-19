'use strict';

// Read-only preflight. Sends NO transactions. Verifies your config + on-chain state.
//   node scripts/check.js
const { Contract, ZeroAddress, formatEther } = require('ethers');
const { config, provider, wallet, hr } = require('./_util');

(async () => {
  hr('CONFIG');
  console.log('dryRun     :', config.dryRun);
  console.log('rpcUrl     :', config.rpcUrl, `(chain ${config.chainId})`);
  console.log('wallet     :', wallet.address, config.walletIsEphemeral ? '⚠️ EPHEMERAL — set WALLET_PRIVATE_KEY' : '');
  console.log('token      :', config.tokenAddress || '⚠️ MISSING — set TOKEN_ADDRESS (PONZI)');
  const { resolveStocks } = require('../src/evm/stocks');
  const picked = resolveStocks(config.stocks);
  console.log('stocks     :', `${picked.length} airdropped per wallet — ${picked.map((s) => s.symbol).join(', ')}`);
  console.log('split      :', `${config.rewardBuyPct}% stocks (airdropped) / ${config.devPct}% dev+gas`);
  console.log('minHold    :', config.minHold, `${config.tokenSymbol} to qualify for airdrops`);
  console.log('factory    :', config.ponsFactory);
  console.log('locker     :', config.ponsLocker);
  console.log('router     :', config.swapRouter);

  hr('RPC + WALLET BALANCE');
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== config.chainId) {
    console.log(`⚠️ RPC reports chain ${net.chainId}, expected ${config.chainId}`);
  } else {
    console.log('chainId    :', Number(net.chainId), '✓');
  }
  const wei = await provider.getBalance(wallet.address);
  console.log('ETH balance:', formatEther(wei), 'ETH');
  if (wei === 0n) console.log('⚠️ wallet has 0 ETH — fund it before any live test');
  const { wethContract } = require('../src/evm/erc20');
  const wethBal = await wethContract().balanceOf(wallet.address);
  console.log('WETH       :', formatEther(wethBal), 'WETH');

  if (!config.tokenAddress) {
    console.log('\nSet TOKEN_ADDRESS to run the remaining checks.');
    process.exit(0);
  }

  hr('PONS.FAMILY LAUNCH RECORD');
  const { getLaunchedToken, getClaimableEth } = require('../src/evm/pons');
  const launch = await getLaunchedToken(config.tokenAddress);
  console.log('exists     :', launch.exists);
  if (!launch.exists) {
    console.log('⚠️ this token was not launched via the pons.family factory on this chain');
    process.exit(0);
  }
  console.log('deployer   :', launch.deployer, launch.deployer.toLowerCase() === wallet.address.toLowerCase() ? '✓ (this wallet — authorized to claim)' : '⚠️ NOT this wallet — collectFees must be called by the deployer/recipient!');
  console.log('pairToken  :', launch.pairedToken, launch.pairedToken.toLowerCase() === config.weth.toLowerCase() ? '✓ (WETH)' : '⚠️ not the configured WETH');
  console.log('poolFee    :', Number(launch.poolFee) / 10000, '% (the buy swap uses this pool)');

  // Fee-redirect safety: if the token's fees are redirected away from this
  // wallet, the claim succeeds but the funds land elsewhere and the cycle starves.
  if (!config.dryRun) {
    const locker = new Contract(config.ponsLocker, ['function feeRedirects(address) view returns (address)'], provider);
    const redirect = await locker.feeRedirects(config.tokenAddress);
    if (redirect && redirect !== ZeroAddress && redirect.toLowerCase() !== wallet.address.toLowerCase()) {
      console.log('feeRedirect:', redirect, '⚠️ fees are redirected AWAY from this wallet — the cycle will have nothing to spend');
    } else {
      console.log('feeRedirect:', redirect === ZeroAddress ? '(none — fees pay the deployer)' : redirect, '✓');
    }
  }

  hr('CLAIMABLE CREATOR FEES');
  if (config.dryRun) {
    console.log('(DRY_RUN — simulated vault; set DRY_RUN=false to read the real position)');
  } else {
    const claimable = await getClaimableEth();
    console.log('claimable  :', claimable, 'ETH (creator remainder of the WETH-side LP fees)');
  }

  console.log('\n✅ preflight complete (no transactions sent)');
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ check failed:', e.message);
  process.exit(1);
});

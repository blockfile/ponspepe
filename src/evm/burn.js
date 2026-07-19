'use strict';

// Burn an ERC-20 by sending it to the dead address — permanently out of
// circulation (the dead address has no private key). Used each cycle to burn the
// RIF the wallet holds: pons pays the creator fee partly in the token itself, so
// that token-side RIF is burned rather than left idle.

const { formatUnits } = require('ethers');
const config = require('../config');
const { erc20, getDecimals } = require('./erc20');
const { wallet } = require('./provider');

async function burnToken(token, amountRaw) {
  const amount = BigInt(amountRaw || '0');
  if (config.dryRun) {
    return {
      signature: `burn_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
      burnedRaw: amount.toString(),
      burned: Number(amount) / 1e18,
      deadAddress: config.deadAddress,
      simulated: true,
    };
  }
  if (amount <= 0n) throw new Error(`nothing to burn (amount ${amountRaw})`);

  const decimals = await getDecimals(token);
  const tx = await erc20(token, wallet).transfer(config.deadAddress, amount);
  await tx.wait();
  console.log(`[tx] burn ${formatUnits(amount, decimals)} ${config.tokenSymbol} → ${config.deadAddress}: ${tx.hash}`);
  return {
    signature: tx.hash,
    burnedRaw: amount.toString(),
    burned: Number(formatUnits(amount, decimals)),
    deadAddress: config.deadAddress,
    simulated: false,
  };
}

module.exports = { burnToken };

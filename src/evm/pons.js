'use strict';

// pons.family creator-fee claiming on Robinhood Chain.
//
// How it works on-chain (verified against the live PonsLaunchFactory / locker):
//   - The PonsLaunchLocker (config.ponsLocker) holds each launched token's
//     Uniswap V3 LP position NFT. Uncollected trading fees accrue in that
//     position.
//   - `collectFees(address token)` on the locker pulls the position's fees to
//     the locker, takes the protocol share (tokenProtocolFeeShares) for the
//     protocol fee recipient, and sends the remainder of BOTH sides to the
//     token's fee recipient — the deployer wallet by default (or feeRedirects).
//     The deployer is authorized to call it, so the operating wallet must be the
//     deployer of TOKEN_ADDRESS; the WETH share lands in this wallet.

const { Contract, Interface, formatEther } = require('ethers');
const config = require('../config');
const { provider, wallet } = require('./provider');
const simvault = require('./simvault');

const FACTORY_ABI = [
  'function getLaunchedToken(address token) view returns (tuple(address token, address deployer, address pairedToken, address positionManager, uint256 positionId, uint256 dexId, uint256 launchConfigId, uint256 restrictionsEndBlock, uint256 supply, bool isToken0, uint24 poolFee, bool exists, uint256 initialBuyAmount))',
];

// PonsLaunchLocker — collectFees(token) claims the position's fees and routes the
// creator remainder to the deployer; tokenProtocolFeeShares(token) reads the
// protocol's percentage cut (creator gets 100 - that).
const LOCKER_FEE_ABI = ['function collectFees(address token) returns (uint256 amount0, uint256 amount1)'];
const LOCKER_VIEW_ABI = ['function tokenProtocolFeeShares(address token) view returns (uint256)'];

// Uniswap V3 NonfungiblePositionManager — static-calling collect() as the
// position owner returns the currently collectable (amount0, amount1) without
// sending a transaction. That is the standard way to read uncollected V3 fees.
const POSITION_MANAGER_ABI = [
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)',
];

const LAUNCHER_TOKEN_ABI = [
  'function liquidityPool() view returns (address)',
  'function poolFee() view returns (uint24)',
  'function pairToken() view returns (address)',
];

const MAX_UINT128 = (1n << 128n) - 1n;
const TRANSFER_IFACE = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const TRANSFER_TOPIC = TRANSFER_IFACE.getEvent('Transfer').topicHash;

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function factory() {
  return new Contract(config.ponsFactory, FACTORY_ABI, provider);
}

function launcherToken(address) {
  return new Contract(address, LAUNCHER_TOKEN_ABI, provider);
}

/** pons.family launch record for a token (throws if TOKEN_ADDRESS is unset). */
async function getLaunchedToken(token = config.tokenAddress) {
  if (!token) throw new Error('TOKEN_ADDRESS is required');
  return factory().getLaunchedToken(token);
}

/**
 * Read the uncollected LP fees for the launched token WITHOUT claiming, split
 * into the WETH side and the token side. Read by static-calling the position
 * manager's collect() as the locker (which owns the position NFT). Live mode only.
 * @returns {Promise<{wethRaw: bigint, tokenRaw: bigint}>} base units
 */
async function getUncollectedLpFees() {
  const launch = await getLaunchedToken();
  if (!launch.exists) throw new Error(`token ${config.tokenAddress} was not launched via the pons.family factory`);

  const pm = new Contract(launch.positionManager, POSITION_MANAGER_ABI, provider);
  const [amount0, amount1] = await pm.collect.staticCall(
    {
      tokenId: launch.positionId,
      recipient: config.ponsLocker,
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128,
    },
    { from: config.ponsLocker } // the locker owns the position NFT
  );
  // launch.isToken0 == our token is token0 → WETH (pair token) is the other side.
  return {
    wethRaw: launch.isToken0 ? amount1 : amount0,
    tokenRaw: launch.isToken0 ? amount0 : amount1,
  };
}

/**
 * The protocol's fee-share percentage for TOKEN_ADDRESS, read from the locker.
 * Falls back to PROTOCOL_FEE_SHARE_PCT if the read fails. The creator (this
 * wallet) receives the remaining (100 - share)%.
 * @returns {Promise<number>} protocol share, percent
 */
async function getProtocolFeeSharePct() {
  try {
    const locker = new Contract(config.ponsLocker, LOCKER_VIEW_ABI, provider);
    const share = Number(await locker.tokenProtocolFeeShares(config.tokenAddress));
    return Number.isFinite(share) && share >= 0 && share <= 100 ? share : config.protocolFeeSharePct;
  } catch (_err) {
    return config.protocolFeeSharePct;
  }
}

/**
 * Read the claimable creator-fee balance WITHOUT claiming (gates the trigger).
 * Estimate: the creator remainder (100 - protocol share) of the WETH-side
 * uncollected LP fees. The token-side fees also accrue to the creator but are
 * not counted here (the trigger is denominated in ETH/WETH).
 * @returns {Promise<number>} claimable ETH (WETH)
 */
async function getClaimableEth() {
  if (config.dryRun) {
    return simvault.peek(); // pure read — accrual happens in simulateFeeAccrual()
  }
  const { wethRaw } = await getUncollectedLpFees();
  const protocolPct = await getProtocolFeeSharePct();
  const creatorShare = (wethRaw * BigInt(Math.round((100 - protocolPct) * 100))) / 10000n;
  return Number(formatEther(creatorShare));
}

/**
 * Advance the simulated creator-fee vault by one poll's worth of fees. DRY_RUN
 * only — in live mode fees accrue on-chain, so this is a no-op. Called once per
 * scheduler poll so the trigger can actually fire in testing.
 */
function simulateFeeAccrual() {
  if (config.dryRun) simvault.accrue(config.dryRunFeePerPoll);
}

/**
 * Claim creator fees: call collectFees(TOKEN_ADDRESS) on the Pons locker. The
 * creator remainder is routed straight to the deployer wallet (this wallet). The
 * claimed WETH amount is read exactly from the receipt's WETH Transfer logs.
 * @returns {Promise<{signature, ethClaimed, simulated, note?}>}
 */
async function claimCreatorFees() {
  if (config.dryRun) {
    const ethClaimed = +simvault.drain().toFixed(6);
    return { signature: fakeSig('claim'), ethClaimed, simulated: true };
  }

  const claimable = await getClaimableEth();
  if (!(claimable > 0)) {
    return { signature: null, ethClaimed: 0, simulated: false, note: 'nothing to claim' };
  }

  const locker = new Contract(config.ponsLocker, LOCKER_FEE_ABI, wallet);
  const tx = await locker.collectFees(config.tokenAddress);
  const receipt = await tx.wait();
  console.log(`[tx] claim creator fees (collectFees): ${tx.hash}`);

  // Sum the WETH actually transferred to our wallet in this tx — the exact payout.
  const me = wallet.address.toLowerCase();
  let wethReceived = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== config.weth.toLowerCase()) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    const parsed = TRANSFER_IFACE.parseLog({ topics: [...log.topics], data: log.data });
    if (parsed.args.to.toLowerCase() === me) wethReceived += parsed.args.value;
  }

  return { signature: tx.hash, ethClaimed: Number(formatEther(wethReceived)), simulated: false };
}

module.exports = {
  getLaunchedToken,
  launcherToken,
  getUncollectedLpFees,
  getProtocolFeeSharePct,
  getClaimableEth,
  simulateFeeAccrual,
  claimCreatorFees,
  MAX_UINT128,
};

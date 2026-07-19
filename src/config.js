'use strict';

require('dotenv').config();

const { Wallet } = require('ethers');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function num(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseClusters(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((g) => Array.isArray(g))
      .map((g) => g.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim()))
      .filter((g) => g.length > 0);
  } catch (_err) {
    console.warn('[ponsliqui] CLUSTERS is not valid JSON — ignoring');
    return [];
  }
}

const DRY_RUN = bool(process.env.DRY_RUN, true);

/**
 * Load the signing wallet (0x-prefixed hex private key). It must be the wallet
 * that deployed PONZI on pons.family — the creator fee share is paid to the
 * deployer address, and that wallet is authorized to call collectFees(). In
 * DRY_RUN with no key configured, an ephemeral wallet is generated so the server
 * runs out of the box (no funds are ever touched).
 */
function loadWallet() {
  const raw = process.env.WALLET_PRIVATE_KEY;
  if (!raw) {
    if (!DRY_RUN) {
      throw new Error('WALLET_PRIVATE_KEY is required when DRY_RUN=false');
    }
    return { wallet: Wallet.createRandom(), ephemeral: true };
  }
  try {
    const key = raw.trim().startsWith('0x') ? raw.trim() : `0x${raw.trim()}`;
    return { wallet: new Wallet(key), ephemeral: false };
  } catch (err) {
    throw new Error(`Could not parse WALLET_PRIVATE_KEY: ${err.message}`);
  }
}

const { wallet, ephemeral: walletIsEphemeral } = loadWallet();

const lowerOrNull = (v) => (v ? String(v).trim().toLowerCase() : null);

// ── Reward split (of each WETH claim) ────────────────────────────────────────
// REWARD_BUY_PCT → buy the reward token and airdrop it to ponspepe holders; the
// remainder (dev cut) is unwrapped to native ETH for gas.
const rewardBuyPct = num(process.env.REWARD_BUY_PCT, 80);
if (rewardBuyPct < 0 || rewardBuyPct > 100) {
  throw new Error(`invalid split: REWARD_BUY_PCT(${rewardBuyPct}) must be within [0, 100]`);
}
const devPct = +(100 - rewardBuyPct).toFixed(6);

// ── Token-side fee ───────────────────────────────────────────────────────────
// The token-side creator fee is burned in full — never transferred, never sold.

const triggerMode = ['interval', 'accumulation'].includes(
  String(process.env.TRIGGER_MODE || 'accumulation').toLowerCase()
)
  ? String(process.env.TRIGGER_MODE || 'accumulation').toLowerCase()
  : 'accumulation';

const config = {
  port: num(process.env.PORT, 3000),
  dryRun: DRY_RUN,

  // Robinhood Chain mainnet defaults.
  rpcUrl: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  chainId: num(process.env.CHAIN_ID, 4663),
  explorerApi: (process.env.EXPLORER_API || 'https://robinhoodchain.blockscout.com').replace(/\/$/, ''),

  wallet,
  walletIsEphemeral,

  // pons.family contracts (Robinhood Chain deployments; override per chain).
  ponsFactory: process.env.PONS_FACTORY || '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB',
  ponsLocker: process.env.PONS_LOCKER || '0x736D76699C26D0d966744cAe304C000d471f7F35',
  weth: process.env.WETH_ADDRESS || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  swapRouter: process.env.SWAP_ROUTER || '0xCaf681a66D020601342297493863E78C959E5cb2',
  // Protocol's share of each collectFees() payout (both fee sides); the creator
  // (this wallet) gets the remainder. pons.family splits trading fees 70% creator
  // / 30% protocol, so this defaults to 30. Used only to ESTIMATE the claimable
  // balance for the trigger — the live path reads the real share on-chain
  // (tokenProtocolFeeShares) and falls back to this, and the actual payout is
  // measured exactly from the receipt's WETH Transfer logs regardless.
  protocolFeeSharePct: num(process.env.PROTOCOL_FEE_SHARE_PCT, 30),

  // The PONZI token you launched on pons.family. Its creator fees fund the cycle.
  tokenAddress: lowerOrNull(process.env.TOKEN_ADDRESS),
  tokenSymbol: process.env.TOKEN_SYMBOL || 'PONZI',

  // ── Reward token (Uniswap V3) ────────────────────────────────────────────
  // Each cycle spends REWARD_BUY_PCT of the WETH claim buying this token, which
  // is then airdropped pro-rata to the ponspepe holders. PONS has no native-ETH
  // V4 pool; its liquidity is a PONS/WETH Uniswap V3 pool, so the buy goes
  // WETH → PONS through the V3 SwapRouter02 (SWAP_ROUTER),
  // at the REWARD_POOL_FEE tier. Address pinned (verified on-chain: the deep pool
  // is the 1% tier; the 0.3% pool is nearly empty).
  rewardToken: lowerOrNull(process.env.REWARD_TOKEN) || '0x39dbed3a2bd333467115de45665cc57f813c4571',
  rewardSymbol: process.env.REWARD_SYMBOL || 'PONS',
  rewardPoolFee: num(process.env.REWARD_POOL_FEE, 10000),

  // ── Split ────────────────────────────────────────────────────────────────
  rewardBuyPct, // % of each claim → buy the reward token (airdropped to holders)
  devPct, // remainder kept as native ETH (dev cut + gas)
  slippagePct: num(process.env.SLIPPAGE_PCT, 5), // reward-buy (WETH→PONS) slippage, percent
  deadAddress: lowerOrNull(process.env.DEAD_ADDRESS) || '0x000000000000000000000000000000000000dead',


  // ── Airdrop (reward token → ponspepe holders) ───────────────────────────────
  minHold: num(process.env.MIN_HOLD, 100000), // min PONZI balance to qualify
  rewardCapPct: num(process.env.REWARD_CAP_PCT, 0), // per-wallet weight cap, % of supply (0 = pure pro-rata)
  clusters: parseClusters(process.env.CLUSTERS), // wallet groups treated as one person for the cap
  airdropBatchSize: num(process.env.AIRDROP_BATCH_SIZE, 30), // max airdrop txs in flight (sliding window); also recipients per disperse batch
  airdropGasLimit: num(process.env.AIRDROP_GAS_LIMIT, 120000), // fixed gas per airdrop transfer (skips per-tx estimateGas)
  disperseAddress: lowerOrNull(process.env.DISPERSE_ADDRESS), // batch-transfer contract (null → pipelined transfers)
  // Extra owner addresses excluded from airdrops (pool, treasury, etc.), comma-separated.
  airdropExclude: (process.env.AIRDROP_EXCLUDE || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // ── Trigger ─────────────────────────────────────────────────────────────────
  // The scheduler ticks on POLL_SCHEDULE only to CHECK the accrued balance — a
  // tick never fires a cycle by itself. TRIGGER_MODE decides the gate:
  //   'accumulation' → fire only once claimable >= CLAIM_EVERY_ETH (default)
  //   'interval'     → fire on whatever has accrued every tick
  triggerMode,
  pollSchedule: process.env.POLL_SCHEDULE || '* * * * *',
  claimEveryEth: num(process.env.CLAIM_EVERY_ETH, 0.01),
  // DRY_RUN only: simulated ETH added to the fee vault each tick, so cycles have
  // something to claim without real fees.
  dryRunFeePerPoll: num(process.env.DRY_RUN_FEE_PER_POLL, 0.01),

  // DexScreener chain slug for /stats market data (graceful nulls until listed).
  dexscreenerChainId: process.env.DEXSCREENER_CHAIN_ID || 'robinhood',

  // Storage (MongoDB)
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  mongoDb: process.env.MONGODB_DB || 'ponsliqui',

  // CORS allowlist (comma-separated). Default: localhost dev origins. Set to your
  // frontend domain(s) in production, or "*" to allow any origin.
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Secret protecting the POST control endpoints. Blank = open (dev); set in prod.
  apiKey: process.env.API_KEY || null,
};

module.exports = config;

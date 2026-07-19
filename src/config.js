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

const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

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

/**
 * The DISCLOSED fee-conversion wallet: it receives the sell-side token-fee,
 * sells it to ETH, and forwards the ETH to DEV_WALLET. Publicly documented as a
 * project wallet (see README) — not a way to obscure attribution. Optional in
 * DRY_RUN and when BURN_PCT=100 (nothing is sold); required otherwise.
 */
function loadSellerWallet() {
  const raw = process.env.SELLER_PRIVATE_KEY;
  if (!raw) return null;
  try {
    const key = raw.trim().startsWith('0x') ? raw.trim() : `0x${raw.trim()}`;
    return new Wallet(key);
  } catch (err) {
    throw new Error(`Could not parse SELLER_PRIVATE_KEY: ${err.message}`);
  }
}

const sellerWallet = loadSellerWallet();

const lowerOrNull = (v) => (v ? String(v).trim().toLowerCase() : null);

// ── Reward split (of each WETH claim) ────────────────────────────────────────
// REWARD_BUY_PCT → buy the stocks and airdrop them to PONZI holders; the
// remainder (dev cut) stays in the wallet as native ETH for gas.
const rewardBuyPct = num(process.env.REWARD_BUY_PCT, 80);
if (rewardBuyPct < 0 || rewardBuyPct > 100) {
  throw new Error(`invalid split: REWARD_BUY_PCT(${rewardBuyPct}) must be within [0, 100]`);
}
const devPct = +(100 - rewardBuyPct).toFixed(6);

// ── Token-side fee split (burn vs disclosed dev-fee sell) ────────────────────
// BURN_PCT of the token-side fee is burned; the rest is sold to ETH for the dev.
const burnPct = num(process.env.BURN_PCT, 5);
if (burnPct < 0 || burnPct > 100) {
  throw new Error(`invalid BURN_PCT(${burnPct}) — must be within [0, 100]`);
}
// A live cycle that sells (BURN_PCT < 100) needs the seller wallet.
if (!DRY_RUN && burnPct < 100 && !sellerWallet) {
  throw new Error('SELLER_PRIVATE_KEY is required when DRY_RUN=false and BURN_PCT < 100');
}

const triggerMode = ['interval', 'accumulation'].includes(
  String(process.env.TRIGGER_MODE || 'interval').toLowerCase()
)
  ? String(process.env.TRIGGER_MODE || 'interval').toLowerCase()
  : 'interval';

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

  // ── Uniswap V4 — the stock buy path ──────────────────────────────────────
  // Robinhood stock tokens have NO V2 pairs and their V3 pools are empty; the
  // liquidity lives in the V4 singleton PoolManager. An EOA can't swap V4
  // directly (unlock/callback), so buys go through the UniversalRouter and are
  // priced by V4Quoter. These deployments are the ones wired to this PoolManager
  // (verified on-chain — other UniversalRouters on this chain point elsewhere).
  universalRouter: process.env.UNIVERSAL_ROUTER || '0xC6da9C87caE2fcecad79E22C398dE16BFAb0cFdA',
  v4Quoter: process.env.V4_QUOTER || '0x628c00B016415Ef530552063faE4154B0CdEb0Ac',
  poolManager: process.env.POOL_MANAGER || '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  // StateView reads V4 pool state (slot0 → sqrtPrice) for the live stock prices
  // shown on the site. Same PoolManager as above.
  v4StateView: process.env.V4_STATE_VIEW || '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',

  // Which stock tokens to buy + airdrop (symbols, comma-separated). Blank = the
  // whole verified registry (see src/evm/stocks.js).
  stocks: list(process.env.STOCKS),

  // Price-sanity bounds for a stock buy. Several V4 pools on this chain are
  // initialised but EMPTY and quote absurd prices (TSM implies ~$179,000,000 a
  // share against a real ~$408). The slippage floor cannot catch that, because
  // amountOutMinimum is derived from the same poisoned quote — so any implied
  // unit price outside this range means "broken pool", and the stock is skipped.
  maxImpliedPriceUsd: num(process.env.MAX_IMPLIED_PRICE_USD, 10000),
  minImpliedPriceUsd: num(process.env.MIN_IMPLIED_PRICE_USD, 0.01),

  // ── Split ────────────────────────────────────────────────────────────────
  rewardBuyPct, // % of each claim → buy STOCKS (airdropped to holders)
  devPct, // remainder kept as native ETH (dev cut + gas)
  slippagePct: num(process.env.SLIPPAGE_PCT, 5), // V4 stock-buy slippage, percent
  deadAddress: lowerOrNull(process.env.DEAD_ADDRESS) || '0x000000000000000000000000000000000000dead',

  // ── Token-side fee split (burn vs disclosed dev-fee sell) ─────────────────
  burnPct, // % of the token-side fee burned; the rest is sold to ETH for the dev
  sellSlippagePct: num(process.env.SELL_SLIPPAGE_PCT, 5), // RIF→WETH slippage floor, percent
  sellerGasReserveEth: num(process.env.SELLER_GAS_RESERVE_ETH, 0.002), // ETH kept in the seller wallet for gas
  sellerWallet, // disclosed fee-conversion signer (or null)
  sellerAddress: sellerWallet ? sellerWallet.address.toLowerCase() : null,
  devWallet: lowerOrNull(process.env.DEV_WALLET) || wallet.address.toLowerCase(),

  // ── Airdrop (stocks → PONZI holders) ────────────────────────────────────────
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
  // The scheduler ticks on POLL_SCHEDULE. TRIGGER_MODE decides the gate:
  //   'interval'     → fire on whatever has accrued every tick (default)
  //   'accumulation' → fire only once claimable >= CLAIM_EVERY_ETH
  triggerMode,
  pollSchedule: process.env.POLL_SCHEDULE || '*/5 * * * *',
  claimEveryEth: num(process.env.CLAIM_EVERY_ETH, 0.005),
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

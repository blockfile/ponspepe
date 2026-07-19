'use strict';

const { toUsd } = require('../evm/price');
const config = require('../config');

const TOKEN_SYMBOL = config.tokenSymbol;

// The cycle emits these step types: claim, buy, airdrop, burn (+ error). Map a
// stored step to the activity-row shape the dashboard renders.
function toActivityRow(s, price) {
  const d = s.detail || {};
  let type;
  let amountEth = null;
  let tokens = null;
  let status = 'Completed';

  switch (s.name) {
    case 'claim':
      type = 'Auto Claim';
      amountEth = d.ethClaimed ?? null;
      status = 'Claimed';
      break;
    case 'buy':
      type = 'Buy';
      amountEth = d.ethSpent ?? null;
      tokens = d.tokensBought ?? null;
      break;
    case 'airdrop':
      type = 'Airdrop';
      tokens = d.sent ?? null; // recipients paid this cycle
      status = 'Airdropped';
      break;
    case 'burn':
      type = 'Burn';
      tokens = d.tokensBurned ?? null;
      status = 'Burned';
      break;
    default:
      type = s.name;
  }
  if (s.status === 'failed') status = 'Failed';

  return {
    id: s.id ?? null,
    cycleId: s.cycle_id,
    type,
    rawType: s.name,
    amountEth,
    usdValue: toUsd(amountEth, price),
    tokens,
    status,
    txHash: s.signature ?? null,
    at: s.created_at,
  };
}

// ── Public (frontend-facing) shapes ──────────────────────────────────────────

// rawType (stored step name) -> the frontend's lowercase activity enum.
const PUBLIC_TYPE = {
  claim: 'claim',
  buy: 'buy',
  airdrop: 'airdrop',
  burn: 'burn',
};

// Map a stored step to the ActivityRow shape the frontend table renders.
// Caller passes steps newest-first (repo.getAllSteps already sorts desc).
function toPublicActivityRow(s, price) {
  const d = s.detail || {};

  let amountEth = null;
  let tokens = null;
  let status = 'completed';
  switch (s.name) {
    case 'claim':
      amountEth = d.ethClaimed ?? null;
      status = 'claimed';
      break;
    case 'buy':
      amountEth = d.ethSpent ?? null;
      tokens = d.tokensBought ?? null;
      break;
    case 'airdrop':
      tokens = d.sent ?? null;
      status = 'airdropped';
      break;
    case 'burn':
      tokens = d.tokensBurned ?? null;
      status = 'burned';
      break;
    default:
      break;
  }
  if (s.status === 'failed') status = 'failed';

  return {
    id: s.id != null ? String(s.id) : s.signature ?? null,
    type: PUBLIC_TYPE[s.name] ?? s.name,
    amountEth,
    // usdtValue MUST be a number — the frontend table calls .toLocaleString()
    // on it with no null guard.
    usdtValue: toUsd(amountEth, price) ?? 0,
    tokens,
    status,
    txHash: s.signature ?? null,
    timestamp: Date.parse(s.created_at) || null, // ISO -> epoch ms
  };
}

// Sum airdrop totals (repo.getAirdropTotals is keyed by reward_token) into a
// headline distributed amount + recipient count.
function sumAirdrops(airdropTotals = {}) {
  const vals = Object.values(airdropTotals);
  return {
    rewardsDistributed: +vals.reduce((s, t) => s + (t.totalUi || 0), 0).toFixed(6),
    rewardSends: vals.reduce((s, t) => s + (t.sends || 0), 0),
    rewardHolders: vals.reduce((m, t) => Math.max(m, t.holders || 0), 0),
  };
}

// Map the backend aggregates to the frontend's flat /stats object. tokenInLp and
// marketCap have no backend source until the token is listed -> null.
function toPublicStats({ stats, unclaimedEth, operatingWallet, market = {}, airdropTotals = {} }) {
  const air = sumAirdrops(airdropTotals);
  return {
    tokenInLp: market.tokenInLp ?? null, // tokens in the LP (DexScreener); null until listed
    marketCap: market.marketCap ?? null, // USD market cap (DexScreener); null until listed
    unclaimedFeesEth: unclaimedEth == null ? null : +unclaimedEth.toFixed(9),
    totalCreatorFeesClaimed: stats.total_eth_claimed,
    // ETH spent buying the reward token that gets airdropped.
    ethSpentBuying: +(stats.total_eth_spent_buy || 0).toFixed(9),
    tokensBought: stats.total_tokens_bought || 0,
    // Reward airdrop headline (per-token totals live in `airdrops`).
    rewardsDistributed: air.rewardsDistributed,
    rewardHolders: air.rewardHolders,
    airdrops: airdropTotals,
    // The signer that performs claim/buy/airdrop.
    operatingWallet: operatingWallet ?? null,
  };
}

// The unclaimed-fees card payload (used by /api/unclaimed and the SSE stream).
// The trigger is ETH-denominated now: report the accumulation threshold (0 in
// interval mode, where every tick fires).
function buildUnclaimedPayload(eth, price) {
  return {
    unclaimedEth: eth == null ? null : +eth.toFixed(9),
    unclaimedUsd: toUsd(eth, price),
    ethPriceUsd: price,
    triggerMode: config.triggerMode,
    claimEveryEth: config.triggerMode === 'accumulation' ? config.claimEveryEth : 0,
  };
}

// Headline numbers for the frontend hero.
function toPublicSummary({ stats, price, marketCapUsd = null, airdropTotals = {} }) {
  const claimedEth = stats.total_eth_claimed || 0;
  const buyEth = stats.total_eth_spent_buy || 0;
  const air = sumAirdrops(airdropTotals);
  return {
    creatorFeesClaimedEth: claimedEth,
    creatorFeesClaimedUsd: +(claimedEth * (price || 0)).toFixed(2),
    marketCapUsd: marketCapUsd ?? null,
    // reward-and-burn totals funded from fees
    ethSpentBuying: +buyEth.toFixed(9),
    ethSpentBuyingUsd: +(buyEth * (price || 0)).toFixed(2),
    tokensBought: stats.total_tokens_bought || 0,
    tokensBurned: stats.total_tokens_burned || 0,
    burns: stats.burns || 0,
    rewardsDistributed: air.rewardsDistributed,
    rewardHolders: air.rewardHolders,
    cycles: stats.completed || 0,
  };
}

module.exports = {
  toActivityRow,
  toPublicActivityRow,
  toPublicStats,
  toPublicSummary,
  buildUnclaimedPayload,
  sumAirdrops,
  TOKEN_SYMBOL,
};

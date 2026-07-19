# ponspepe

**Turns your ponspepe token's creator fees into PONS airdrops for your holders —
on Robinhood Chain.**

Every claim, the bot recycles your ponspepe creator fees into a PONS airdrop:

```
claim ponspepe creator fees (WETH + the token itself)  — collectFees() on the pons.family locker

  ── token-side fee (paid in ponspepe) ──
  →  5%  burned (sent to the dead address)
  → 95%  sold to ETH by the DISCLOSED fee-conversion wallet → sent to the dev

  ── WETH ──
  → 80%  buy PONS (Uniswap V3) → airdrop to every ponspepe holder (pro-rata, >= MIN_HOLD)
  → 20%  unwrapped to native ETH (dev cut + gas)
```

Every eligible holder receives PONS every cycle. The token-side fee is split
(`BURN_PCT`): the default **5% is burned, 95% is sold to ETH for the dev** — see
[Token-side fee](#token-side-fee-burn--disclosed-dev-fee) below. The sold portion
is a **disclosed dev fee**, never counted as a burn.

Everything runs in `DRY_RUN=true` by default — all on-chain calls are simulated
and no funds are touched until you flip it off.

## The reward token: PONS on Uniswap V3

The reward is a single token — **PONS**
(`0x39dBED3a2bd333467115dE45665cC57F813C4571`), the pons.family platform token —
bought with the claimed WETH and airdropped to your holders. PONS is an ordinary
ERC-20 (18 dp), so airdropping it is just `transfer`. *Buying* it is the
interesting part — and the venue is not the obvious one, all verified on-chain:

| Venue | Reality |
|---|---|
| Uniswap **V4** | no native-ETH PONS pool (unlike the Robinhood stock tokens) |
| Uniswap **V3** | ✅ a real PONS/WETH pool — the deep one is the **1% (`fee=10000`)** tier |

So the bot buys PONS on **V3**, swapping **WETH → PONS** through the same
SwapRouter02 the fee-sell uses (`SWAP_ROUTER`), at `REWARD_POOL_FEE`. The claim is
kept as WETH for this (no unwrap); only the dev remainder is unwrapped to ETH.

> The address is pinned, never the symbol — the chain has copycats squatting
> tickers. Verified on-chain: two PONS/WETH V3 pools exist; the 1% tier holds
> ~18,000× the liquidity of the 0.3% tier, so `REWARD_POOL_FEE` defaults to
> `10000`.

## How the pons.family fee claim works

pons.family deploys each token into a Uniswap V3 pool and locks the LP in its
**PonsLaunchLocker**. `collectFees(token)` pulls the position's fees, takes the
protocol share, and pays the creator remainder to the token's fee recipient — the
**deployer**. So the operating wallet **must be the wallet that deployed ponspepe
on pons.family**; the WETH lands there and the cycle spends it on the PONS buy.

## Token-side fee: burn + disclosed dev fee

pons.family pays the creator fee partly in **WETH** and partly in the **token
itself** (ponspepe). Each cycle, that token-side ponspepe is split (`BURN_PCT`,
default 5):

- **`BURN_PCT`% is burned** — sent to the dead address, permanently out of supply.
- **The remainder is sold to ETH** on the ponspepe/WETH Uniswap **V3** launch pool
  by the project's **disclosed fee-conversion wallet** (`SELLER_PRIVATE_KEY`),
  which then forwards the ETH to the dev wallet (`DEV_WALLET`), keeping a small gas
  reserve.

This is a **disclosed dev fee, not a burn.** Selling the token is not the same as
burning it, and this is reported that way everywhere:

- `/v1/stats` returns `ponspepeBurned`, `ponspepeSold`, and `ethToDev`
  **separately** — the sold portion is never merged into the burn figure.
- The fee-conversion wallet address is **published here**:
  `<PUBLISH THE SELLER ADDRESS HERE>`.

The WETH leg (the PONS buy + airdrop) is funded **only** by the claimed WETH — the
ETH from selling the fee goes to the dev, not into the reward budget.

Before enabling this live, run `node scripts/verify-sell-route.js` (see
[scripts/](scripts/)) against the real chain to confirm the router/pool, and
pre-fund the seller wallet with a little native ETH for gas.

## The reward leg, precisely

- The holder snapshot is taken **once** per cycle, and the PONS bought this cycle
  is distributed against it, pro-rata by ponspepe balance.
- Only what was **actually bought this cycle** is distributed, measured from the
  **balance delta** (never the router's return value), so a partial fill can't
  overstate a drop. A holder's own balance is never touched.
- Eligibility: `>= MIN_HOLD` ponspepe. The operating wallet, dead address, the
  ponspepe pool, locker, factory, and the PONS token itself are all excluded.
- If the buy fails (no liquidity, revert) it's recorded and the airdrop is skipped
  — the cycle still finishes, and the token-side burn/sell already happened.

## Trigger

The scheduler polls on `POLL_SCHEDULE` (default **every minute**), but a tick only
**checks** the accrued fees — it never fires a cycle by itself. In the default
**accumulation** mode a cycle fires only once claimable `>= CLAIM_EVERY_ETH`
(default `0.01` ETH). `POST /api/run` forces one immediately regardless.

## Quick start

```bash
npm install
cp .env.example .env       # safe defaults: DRY_RUN=true, ephemeral wallet
npm test                   # in-memory MongoDB
npm start
```

## Config

| Env | Default | Meaning |
|---|---|---|
| `TOKEN_ADDRESS` | — | your ponspepe token on pons.family (its fees fund everything) |
| `REWARD_TOKEN` | `0x39dB…4571` (PONS) | the token bought + airdropped to holders |
| `REWARD_POOL_FEE` | `10000` | the PONS/WETH Uniswap V3 fee tier to buy through |
| `REWARD_BUY_PCT` | `80` | % of each WETH claim → buy the reward (airdropped) |
| `MIN_HOLD` | `100000` | min ponspepe balance to qualify for a drop |
| `REWARD_CAP_PCT` | `0` | optional per-wallet cap (anti-whale); 0 = off |
| `SLIPPAGE_PCT` | `5` | reward-buy (WETH→PONS) slippage tolerance |
| `TRIGGER_MODE` / `CLAIM_EVERY_ETH` | `accumulation` / `0.01` | fire a cycle once `>= this` ETH has accrued |
| `POLL_SCHEDULE` | `* * * * *` | how often to check the accrued balance |

## Going live

1. Fill `.env`: `WALLET_PRIVATE_KEY` (the **deployer** of ponspepe), `TOKEN_ADDRESS`,
   `MONGODB_URI`, `DRY_RUN=false`. Fund the wallet with native ETH for gas.
2. `node scripts/check.js` — read-only preflight.
3. `node scripts/run-once.js --confirm` — one full cycle, then `npm start`.

## Verified, not assumed

- The full dry-run cycle is covered by tests (claim → burn/sell the token-side fee
  → buy PONS on V3 → airdrop → dev).
- The PONS/WETH V3 pool and fee tier were confirmed against the live chain (deep
  pool = the 1% / `fee=10000` tier). Run `node scripts/verify-sell-route.js`
  before going live to re-confirm the route on-chain.

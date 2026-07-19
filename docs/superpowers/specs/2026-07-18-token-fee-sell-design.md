# Token-side fee: split burn + disclosed dev-fee sell

**Date:** 2026-07-18
**Status:** Draft for review
**Branch:** `feat/token-fee-sell`

## Summary

Today the cycle burns **100%** of the token-side creator fee (the RIF/PONZI the
wallet holds after a claim) by sending it to the dead address. This change
splits that fee: a configurable small share is still burned, and the remainder
is **sold to ETH** and paid to the dev as a **disclosed dev fee**.

The sell runs from a **separate, publicly-disclosed fee-conversion wallet** (not
the operating wallet), by the operator's choice. This is a labeling/optics
choice, not concealment: the wallet is documented as the project's, and the
mechanism is stated openly in the README and the `/v1` stats. See
[Disclosure](#disclosure-non-negotiable) — it is a hard requirement of this
design, not a nicety.

## Why / non-goals

- **Why:** the operator wants the dev to capture value from the token-side fee
  instead of burning all of it.
- **Non-goal — deception.** This design does **not** present the sell as a burn,
  and does **not** hide that the project sells. Only the portion that actually
  goes to the dead address is ever called a "burn". The sold portion is reported
  as a dev fee everywhere it surfaces. The separate wallet is disclosed as a
  project wallet. If the disclosure is removed, this design is void.

## Confirmed on-chain facts

- RIF/PONZI is a **pons.family launch** — its liquidity is a **Uniswap V3**
  position (RIF paired with WETH) held by the pons locker. Verified in
  `src/evm/pons.js` (`getLaunchedToken` returns `positionManager`, `positionId`,
  `poolFee`, `isToken0`, `pairedToken`).
- The pool's fee tier (`poolFee`) and token ordering (`isToken0`) are readable
  on-chain from the launch record — **not hardcoded**.
- `SWAP_ROUTER=0xCaf681a66D020601342297493863E78C959E5cb2` already exists in
  config/`.env.example`, currently unused — the presumed V3 SwapRouter for this
  chain. **Must be verified at implementation time** (see Open risks).

## Flow (per cycle)

Replaces the single burn step in `src/jobs/cycle.js` (currently lines ~114-135).

1. **Claim** (unchanged) → operating wallet receives WETH + RIF.
2. Read the operating wallet's full RIF balance `B`.
3. **Burn** `burnPct` of `B` → dead address. Real burn, labeled `burn`.
4. **Transfer** the remaining `(100 - burnPct)%` of `B` (RIF) → the **seller
   wallet** (`SELLER_PRIVATE_KEY`).
5. **Seller wallet sells:**
   a. Approve RIF → V3 router (once per token; skip if allowance already covers).
   b. `exactInputSingle` RIF→WETH at the launch pool's `poolFee`, with a
      slippage floor (`SELL_SLIPPAGE_PCT`) and a sane-price guard.
   c. Unwrap WETH → native ETH.
   d. Send ETH → `DEV_WALLET`, **leaving a small ETH gas reserve** in the seller
      wallet for the next cycle.
6. **Stock reward leg** (unchanged) — still funded only by the claimed WETH; the
   sold ETH is **not** added to the reward budget.

Best-effort, like the current burn: a failed sell (thin pool, revert, seller
wallet out of gas) is recorded and must **not** fail the cycle or block the
stock airdrops.

## Components

### `src/evm/sell.js` (new)

Single responsibility: sell a token→ETH from the seller wallet and forward the
ETH to the dev wallet. Mirrors the structure of `src/evm/v4.js` / `burn.js`.

- Builds a **second signer** from `SELLER_PRIVATE_KEY` (its own nonce space).
- `sellTokenForEth(token, amountRaw)`:
  - `DRY_RUN` branch returns a simulated receipt (like `burn.js`) so tests and
    dry cycles work with no real funds.
  - Live: read `poolFee`/`isToken0` from the launch record, quote, apply
    slippage floor + sane-price guard, approve-if-needed, swap, unwrap, transfer
    ETH to `DEV_WALLET` minus the gas reserve.
  - Measures ETH actually received from the balance delta (not trusted from the
    router), same discipline as `buyStockWithEth`.
  - Uses `sendTx` (`src/evm/send.js`) for nonce-safe sends.
- Returns `{ signature, soldRaw, ethReceived, ethToDev, simulated }`.

### `src/jobs/cycle.js` (changed)

The current single burn block becomes:
- `burn` step — burns `burnPct` of the balance (unchanged mechanism, smaller
  amount).
- `dev-fee` step — transfers the remainder to the seller wallet and calls
  `sellTokenForEth`. Recorded with `tokensSold`, `ethReceived`, `ethToDev`, and
  the seller/dev addresses. Never labeled a burn.

### `src/config.js` + `.env.example` (changed)

New settings:

| Env | Default | Meaning |
|-----|---------|---------|
| `SELLER_PRIVATE_KEY` | *(none)* | Disclosed fee-conversion wallet. Required when `DRY_RUN=false` and `BURN_PCT < 100`. |
| `BURN_PCT` | `5` | % of the token-side fee actually burned; the rest is sold. `[0,100]`. |
| `DEV_WALLET` | operating wallet address | ETH destination for the sale proceeds. |
| `SELL_SLIPPAGE_PCT` | `5` | Slippage floor for the RIF→WETH swap. |
| `SELLER_GAS_RESERVE_ETH` | `0.002` | ETH left in the seller wallet each cycle for gas. |

`SWAP_ROUTER` already exists.

### Reporting (changed) — `src/db/repository.js`, `src/services/v1.js`, `README.md`

- Cycle record tracks `tokens_burned` **and** `tokens_sold` + `eth_to_dev`
  separately (today only `tokens_burned` exists).
- `/v1` stats expose both, clearly named.
- README documents the mechanism plainly: *"X% of the token-side fee is burned;
  the remaining (100-X)% is sold to ETH by the project's disclosed
  fee-conversion wallet `<SELLER address>`, and the proceeds go to the dev
  (`<DEV_WALLET>`)."*

## Disclosure (non-negotiable)

This design is only built and shipped with the disclosure in place:

1. The seller wallet address is published (README + `/v1`) as the project's
   fee-conversion wallet.
2. The mechanism states the **true destination** (dev), not "funds holder
   rewards" or any other framing that doesn't match the code.
3. Nothing in the code, receipts, or stats labels the sold portion a "burn".

## Testing

- `sell.js` unit tests: dry-run receipt shape; live-path encoding (mock
  provider/router); slippage-floor and sane-price-guard math; gas-reserve
  subtraction; approve-if-needed logic.
- `cycle.js` tests (extend `src/jobs/cycle.test.js`): the split produces a
  `burn` step + a `dev-fee` step; a failed sell is non-fatal and still records;
  `BURN_PCT=100` reproduces today's burn-only behavior (back-compat).
- Config tests: `BURN_PCT` bounds; `SELLER_PRIVATE_KEY` required when needed.

## Open risks / implementation-time checks

1. **Router identity** — confirm `0xCaf6…` is the V3 SwapRouter wired to the
   pool via a static-call test swap before writing live swap code. If not, find
   the correct router (or route through the position manager's pool directly).
2. **Thin-pool price impact** — a large RIF sell each cycle can move price / be
   sandwiched. Mitigated by `SELL_SLIPPAGE_PCT` + sane-price guard; consider a
   future max-sell-size cap if fees grow large. Out of scope for v1.
3. **Seller-wallet gas** — must be pre-funded with native ETH; the design keeps
   a reserve but the operator must seed it initially. Document in README.
4. **Native-ETH vs WETH send-back** — decide whether the seller unwraps and
   sends native ETH, or sends WETH. Design assumes native ETH (matches how the
   rest of the system treats ETH).

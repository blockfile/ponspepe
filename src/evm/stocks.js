'use strict';

// The Robinhood tokenized assets this bot buys and airdrops — the TOP 10 by real
// Uniswap V4 liquidity.
//
// Every entry was verified on-chain twice over: it has a live V4 pool against
// NATIVE ETH with non-zero liquidity (read from StateView), AND its quote prices
// sanely against the real market (e.g. NVDA quoted $211 vs a real ~$207).
//
// This list is deliberately short. Of ~38 Robinhood tokens with an initialised
// ETH pool, only ELEVEN price sanely — and the split is perfectly clean:
//   * every healthy pool is fee 50000 / tickSpacing 1000
//   * every fee 10000 / tickSpacing 200 pool is an empty placeholder that quotes
//     absurd prices (TSM implies ~$179,000,000/share against a real ~$408; AVGO
//     ~$136,000,000 vs ~$374). Buying through one would burn the ETH for dust.
// So NFLX, COIN, ORCL, INTC, MU, GME, QQQ, SLV, TSM, AVGO, AMAT, RKLB, … are
// excluded on purpose. META is the 11th and just misses the cut.
//
// Gold/silver are NOT obtainable here: XAU/XAG/XAUT/PAXG have no usable ETH pool
// (the on-chain "GOLD"/"XAUT" tokens are unrelated memecoins — one is literally
// "Trump Gold"), and USDC likewise ("United States Dump Coin").
//
// Pin addresses, never symbols: the chain is full of copycats squatting real
// tickers (there is a fake "SPCX" literally named ScammingPeopleCashXtraction).

const { ZeroAddress } = require('ethers');

const V4_FEE = 50000; // 5% — the ONLY tier with real stock liquidity
const V4_TICK_SPACING = 1000;

// Ordered by measured V4 liquidity, deepest first.
//
// This is the requested basket (NVDA, AAPL, GOOGL, MSFT, AMZN, SPCX, META, TSLA)
// plus two fills, because the requested XAU (gold) and XAG (silver) are simply
// not obtainable on this chain — no Robinhood metal token has a usable ETH pool,
// and the SLV ETF's pool is one of the broken ones ($11.3M/unit implied).
// The fills are the two most liquid remaining sane assets: AMD, and SPY — an
// S&P 500 ETF, the closest available stand-in for the broad-market exposure the
// metals were there to provide. Swap SPY → PLTR if you'd rather stay all-stocks.
const REGISTRY = [
  { symbol: 'NVDA', name: 'NVIDIA', token: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' },
  { symbol: 'SPCX', name: 'SpaceX', token: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa' },
  { symbol: 'TSLA', name: 'Tesla', token: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d' },
  { symbol: 'AAPL', name: 'Apple', token: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9' },
  { symbol: 'AMD', name: 'AMD', token: '0x86923f96303D656E4aa86D9d42D1e57ad2023fdC' },
  { symbol: 'GOOGL', name: 'Alphabet', token: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3' },
  { symbol: 'AMZN', name: 'Amazon', token: '0x12f190a9F9d7D37a250758b26824B97CE941bF54' },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', token: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C' },
  { symbol: 'MSFT', name: 'Microsoft', token: '0xe93237C50D904957Cf27E7B1133b510C669c2e74' },
  { symbol: 'META', name: 'Meta', token: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35' },
].map((s) => ({
  ...s,
  token: s.token.toLowerCase(),
  fee: V4_FEE,
  tickSpacing: V4_TICK_SPACING,
  hooks: ZeroAddress,
  decimals: 18, // Robinhood stock tokens are 18-decimal ERC-20s
}));

const BY_SYMBOL = new Map(REGISTRY.map((s) => [s.symbol, s]));

/**
 * The stocks a cycle should buy: the configured STOCKS symbols, or all of the
 * registry when unset. Throws on an unknown symbol rather than silently paying
 * out fewer stocks than the operator asked for.
 * @param {string[]} symbols
 * @returns {object[]}
 */
function resolveStocks(symbols) {
  if (!symbols || symbols.length === 0) return [...REGISTRY];
  return symbols.map((raw) => {
    const sym = String(raw).trim().toUpperCase();
    const s = BY_SYMBOL.get(sym);
    if (!s) {
      throw new Error(`unknown stock "${sym}" — known: ${[...BY_SYMBOL.keys()].join(', ')}`);
    }
    return s;
  });
}

module.exports = { REGISTRY, BY_SYMBOL, resolveStocks, V4_FEE, V4_TICK_SPACING };

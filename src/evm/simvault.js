'use strict';

// In-memory simulated creator-fee vault, used ONLY in DRY_RUN so the timer
// trigger can be exercised and tested without real fees. Live mode never
// touches this — real fees accrue in the token's V3 LP position on-chain.
let balanceEth = 0;

// Add `rate` ETH to the simulated vault; returns the new balance.
function accrue(rate) {
  balanceEth += Number(rate) || 0;
  return balanceEth;
}

// Current simulated balance, WITHOUT mutating it.
function peek() {
  return balanceEth;
}

// Claim the whole vault: return the balance and reset to 0.
function drain() {
  const eth = balanceEth;
  balanceEth = 0;
  return eth;
}

// Test helper — force the balance to a known value.
function reset(eth = 0) {
  balanceEth = Number(eth) || 0;
  return balanceEth;
}

module.exports = { accrue, peek, drain, reset };

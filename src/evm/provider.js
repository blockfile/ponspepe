'use strict';

const { JsonRpcProvider } = require('ethers');
const config = require('../config');

// A single shared RPC provider. In DRY_RUN nothing here actually hits the
// network unless a balance read is explicitly requested. Pinning the chain id
// skips the eth_chainId round-trip and guards against a mispointed RPC_URL.
const provider = new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true });

const wallet = config.wallet.connect(provider);

function walletAddress() {
  return wallet.address;
}

module.exports = { provider, wallet, walletAddress };

'use strict';
// Chain registry: MAINNETS ONLY. MintPilot has no testnet or local-node mode at runtime (tests inject
// their own local chain). No ethers dependency so it can be used everywhere (and in unit tests).
//
// Every entry was checked against the network's official docs or the viem chain definitions
// (Nov 2026). Re-check before changing an id or a default RPC; the RPC answer to eth_chainId is
// verified at startup of each endpoint anyway (a mismatch quarantines that endpoint).
//
// Fields
//   chainId      EIP-155 id.
//   currency     native gas/payment coin. Every chain here uses ETH, so the ETH-denominated safety caps
//                (MAX_MINT_VALUE_ETH, AUTOMATION_MAX_VALUE_ETH) mean the same thing on every chain.
//                Non-ETH chains (Polygon, ApeChain, ...) need per-chain caps first: docs/HANDOFF.md.
//   defaultRpc   public endpoint; rate limited. Production needs a provider endpoint per chain.
//   explorer     human links (tx / address pages).
//   abiApi       Blockscout instance used for verified-ABI discovery (free, no key). Sourcify and an
//                optional Etherscan V2 key are tried after it (src/core/abiSources.js).
//   opensea      OpenSea REST chain identifier (values from the official opensea-js Chain enum).
//   ordering     'fcfs'  — arrival order decides position; priority fees do not (Arbitrum Nitro /
//                          Orbit chains): MintPilot tips 0.
//                'fee'   — priority fee influences ordering (Ethereum, OP Stack): RPC-suggested tip
//                          unless PRIORITY_FEE_GWEI_JSON overrides it.
//   stack        'ethereum' | 'op' | 'orbit' — informs gas behaviour (Orbit/Arbitrum gas estimates
//                include parent-chain data cost; see GAS_CAP_JSON).
const DEFS = {
  ethereum: {
    key: 'ethereum', name: 'Ethereum', chainId: 1, currency: 'ETH', confirmations: 2, stack: 'ethereum',
    defaultRpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io', abiApi: 'https://eth.blockscout.com',
    opensea: 'ethereum', ordering: 'fee'
  },
  base: {
    key: 'base', name: 'Base', chainId: 8453, currency: 'ETH', confirmations: 1, stack: 'op',
    defaultRpc: 'https://mainnet.base.org', explorer: 'https://basescan.org', abiApi: 'https://base.blockscout.com',
    opensea: 'base', ordering: 'fee'
  },
  ink: {
    key: 'ink', name: 'Ink', chainId: 57073, currency: 'ETH', confirmations: 1, stack: 'op',
    defaultRpc: 'https://rpc-gel.inkonchain.com', explorer: 'https://explorer.inkonchain.com', abiApi: 'https://explorer.inkonchain.com',
    opensea: 'ink', ordering: 'fee'
  },
  robinhood: {
    key: 'robinhood', name: 'Robinhood Chain', chainId: 4663, currency: 'ETH', confirmations: 1, stack: 'orbit',
    defaultRpc: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com', abiApi: 'https://robinhoodchain.blockscout.com',
    opensea: 'robinhood', ordering: 'fcfs'
  },
  arbitrum: {
    key: 'arbitrum', name: 'Arbitrum One', chainId: 42161, currency: 'ETH', confirmations: 1, stack: 'orbit',
    defaultRpc: 'https://arb1.arbitrum.io/rpc', explorer: 'https://arbiscan.io', abiApi: 'https://arbitrum.blockscout.com',
    opensea: 'arbitrum', ordering: 'fcfs'
  },
  optimism: {
    key: 'optimism', name: 'OP Mainnet', chainId: 10, currency: 'ETH', confirmations: 1, stack: 'op',
    defaultRpc: 'https://mainnet.optimism.io', explorer: 'https://optimistic.etherscan.io', abiApi: 'https://optimism.blockscout.com',
    opensea: 'optimism', ordering: 'fee'
  },
  zora: {
    key: 'zora', name: 'Zora', chainId: 7777777, currency: 'ETH', confirmations: 1, stack: 'op',
    defaultRpc: 'https://rpc.zora.energy', explorer: 'https://explorer.zora.energy', abiApi: 'https://explorer.zora.energy',
    opensea: 'zora', ordering: 'fee'
  },
  shape: {
    key: 'shape', name: 'Shape', chainId: 360, currency: 'ETH', confirmations: 1, stack: 'op',
    defaultRpc: 'https://mainnet.shape.network', explorer: 'https://shapescan.xyz', abiApi: 'https://shapescan.xyz',
    opensea: 'shape', ordering: 'fee'
  },
  unichain: {
    key: 'unichain', name: 'Unichain', chainId: 130, currency: 'ETH', confirmations: 1, stack: 'op',
    defaultRpc: 'https://mainnet.unichain.org', explorer: 'https://uniscan.xyz', abiApi: 'https://unichain.blockscout.com',
    opensea: 'unichain', ordering: 'fee'
  },
  soneium: {
    key: 'soneium', name: 'Soneium', chainId: 1868, currency: 'ETH', confirmations: 1, stack: 'op',
    defaultRpc: 'https://rpc.soneium.org', explorer: 'https://soneium.blockscout.com', abiApi: 'https://soneium.blockscout.com',
    opensea: 'soneium', ordering: 'fee'
  }
};

/** Environment variable holding the primary RPC URL for a chain key, e.g. ARBITRUM_RPC_URL. */
const rpcEnvName = (key) => `${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_RPC_URL`;

/**
 * Runtime chain map. `defs` is injectable so tests can add a local Hardhat chain without the
 * production registry ever containing one.
 */
function getChains(cfg, defs = DEFS) {
  const out = {};
  for (const [key, def] of Object.entries(defs)) {
    const primary = (cfg.rpcUrls && cfg.rpcUrls[key]) || def.defaultRpc;
    const fallbacks = (cfg.rpcFallbackUrls && cfg.rpcFallbackUrls[key]) || [];
    const rpcUrls = [...new Set([primary, ...fallbacks].filter(Boolean))];
    out[key] = { ...def, rpcUrl: rpcUrls[0], rpcUrls };
  }
  return out;
}

const txUrl = (chain, hash) => `${chain.explorer}/tx/${hash}`;
/** OpenSea REST chain identifier for an internal chain key, or null when OpenSea routing is unsupported there. */
const openSeaChainFor = (key) => (DEFS[key] && DEFS[key].opensea) || null;
const addressUrl = (chain, addr) => `${chain.explorer}/address/${addr}`;

module.exports = { DEFS, getChains, txUrl, addressUrl, openSeaChainFor, rpcEnvName };

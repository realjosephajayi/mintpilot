// Hardhat is used ONLY for the contract test suite (local in-process chain). MintPilot itself runs on
// mainnets only and never reads a deployer key; there are no testnet networks here on purpose.
require('@nomicfoundation/hardhat-toolbox');

module.exports = {
  solidity: {
    version: '0.8.24',
    // shanghai keeps bytecode portable across Ethereum, OP Stack and Arbitrum/Orbit chains
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai' }
  },
  paths: { tests: './test/contracts' },
  networks: {
    hardhat: { chainId: 31337 }
  }
};

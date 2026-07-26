require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.28',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // The generated Groth16 verifier is one large assembly block; without
      // this the optimiser can run out of stack slots on some solc versions.
      viaIR: false,
    },
  },
  networks: {
    hardhat: {
      // Deposits are capped by wall-clock weeks since deploy, so tests need
      // to move time forward; allow it.
      allowBlocksWithSameTimestamp: true,
    },
    robinhood: {
      url: process.env.ROBINHOOD_RPC || 'https://rpc.mainnet.chain.robinhood.com',
      chainId: 4663,
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
    },
  },
  mocha: { timeout: 300000 },
};

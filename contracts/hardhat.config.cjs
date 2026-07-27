require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
require('@nomicfoundation/hardhat-verify');

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
  // Source verification on Blockscout, so the deployed bytecode can be checked
  // against the code in this repository by anyone, without asking us.
  //
  // The compiler settings above are part of the claim: verification only
  // succeeds if solc 0.8.28 with the optimizer at 200 runs and viaIR off
  // reproduces the exact bytecode on chain. Changing any of them silently
  // breaks it, which is the point.
  etherscan: {
    apiKey: { robinhood: 'blockscout-needs-no-key' },
    customChains: [
      {
        network: 'robinhood',
        chainId: 4663,
        urls: {
          apiURL: 'https://robinhoodchain.blockscout.com/api',
          browserURL: 'https://robinhoodchain.blockscout.com',
        },
      },
    ],
  },
  sourcify: { enabled: false },

  mocha: { timeout: 300000 },
};

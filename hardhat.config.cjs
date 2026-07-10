require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** Clerk — deploy config for X Layer (OKX).
 *  Gas token is OKB on both networks. Fund the deployer:
 *   - testnet: X Layer faucet (test OKB)
 *   - mainnet: withdraw/bridge OKB from OKX to X Layer
 */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    xlayerTestnet: {
      // Primary can timeout; drpc is more reliable from some regions.
      url: process.env.XLAYER_RPC || "https://xlayer-testnet.drpc.org",
      chainId: 1952,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      timeout: 120000,
    },
    xlayer: {
      url: "https://rpc.xlayer.tech",
      chainId: 196,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
};

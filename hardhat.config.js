require("dotenv").config();
require("@nomiclabs/hardhat-ethers");

function deploymentAccounts() {
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY || "";
  if (!privateKey) return [];

  const normalized = privateKey.startsWith("0x")
    ? privateKey
    : `0x${privateKey}`;

  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("DEPLOYER_PRIVATE_KEY must be a 32-byte hex private key");
  }
  return [normalized];
}

/** @type import("hardhat/config").HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      evmVersion: "cancun",
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    sepolia: {
      url:
        process.env.SEPOLIA_RPC_URL ||
        "https://ethereum-sepolia-rpc.publicnode.com",
      accounts: deploymentAccounts(),
    },
    polygonAmoy: {
      url:
        process.env.POLYGON_RPC_URL ||
        "https://rpc-amoy.polygon.technology",
      accounts: deploymentAccounts(),
      chainId: 80002,
    },
  },
};

require("dotenv").config();

const { ethers } = require("ethers");

const KEY_NAMES = [
  "DEPLOYER_PRIVATE_KEY",
  "TRUSTED_ISSUER_PRIVATE_KEY",
  "ENDPOINT_PRIVATE_KEY",
  "BUYER_PRIVATE_KEY",
  "GATEWAY_PRIVATE_KEY",
  "RELAYER_PRIVATE_KEY",
];
const ADDRESS_NAMES = [
  "ESCROW_V2_ADDRESS",
  "REGISTRY_V2_ADDRESS",
  "ESCROW_ADDRESS",
  "CAP_MANAGER_ADDRESS",
  "BATCH_VERIFIER_ADDRESS",
];

async function main() {
  const networks = [
    ["sepolia", process.env.SEPOLIA_RPC_URL, 11155111],
    ["polygonAmoy", process.env.POLYGON_RPC_URL, 80002],
  ];
  const providers = {};
  for (const [name, url, expectedChainId] of networks) {
    if (!url) throw new Error(`${name} RPC URL is not configured`);
    const provider = new ethers.providers.StaticJsonRpcProvider(url, {
      chainId: expectedChainId,
      name,
    });
    try {
      await provider.getBlockNumber();
    } catch (error) {
      throw new Error(`${name} RPC unavailable: ${error.reason || error.code || error.message}`);
    }
    providers[name] = provider;
  }

  const accounts = [];
  const seen = new Set();
  for (const keyName of KEY_NAMES) {
    const privateKey = process.env[keyName];
    if (!privateKey) continue;
    const wallet = new ethers.Wallet(privateKey);
    if (seen.has(wallet.address)) continue;
    seen.add(wallet.address);
    const balances = {};
    for (const [networkName] of networks) {
      balances[networkName] = ethers.utils.formatEther(
        await providers[networkName].getBalance(wallet.address)
      );
    }
    accounts.push({ keyName, address: wallet.address, balances });
  }

  const configuredContracts = [];
  for (const variable of ADDRESS_NAMES) {
    const address = process.env[variable];
    if (!address || !ethers.utils.isAddress(address)) continue;
    const codeBytes = {};
    for (const [networkName] of networks) {
      const code = await providers[networkName].getCode(address);
      codeBytes[networkName] = Math.max(0, (code.length - 2) / 2);
    }
    configuredContracts.push({ variable, address, codeBytes });
  }
  console.log(JSON.stringify({ accounts, configuredContracts }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

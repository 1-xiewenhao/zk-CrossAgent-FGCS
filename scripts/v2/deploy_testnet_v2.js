require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { ethers, artifacts } = require("hardhat");
const { poseidonContract } = require("circomlibjs");
const { settlementDomainHash } = require("../../lib/protocol-v2");
const {
  commandOutput,
  sha256File,
  writeJson,
} = require("../../lib/v2/experiment-utils");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const DEFAULT_CONFIG_PATH = path.join(
  PROJECT_ROOT,
  "experiments/v2/configs/submission-testnet-20261015.json"
);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function deploymentKey() {
  const keyName = process.env.TESTNET_DEPLOYER_KEY_NAME || "GATEWAY_PRIVATE_KEY";
  const privateKey = required(keyName);
  return { keyName, privateKey };
}

function predictedAddress(address, nonce) {
  return ethers.utils.getContractAddress({ from: address, nonce });
}

async function feeOverrides(provider, chainId) {
  const feeData = await provider.getFeeData();
  if (chainId === 80002) {
    const priority = ethers.utils.parseUnits("30", "gwei");
    const providerPriority = feeData.maxPriorityFeePerGas || priority;
    const maxPriorityFeePerGas = providerPriority.gt(priority)
      ? providerPriority
      : priority;
    const floorMax = ethers.utils.parseUnits("60", "gwei");
    const providerMax = feeData.maxFeePerGas || floorMax;
    const maxFeePerGas = providerMax.gt(floorMax) ? providerMax : floorMax;
    return { maxPriorityFeePerGas, maxFeePerGas };
  }
  if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
    return {
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
    };
  }
  return { gasPrice: await provider.getGasPrice() };
}

async function deploy(factory, args, options, confirmations) {
  const contract = await factory.deploy(...args, options);
  const receipt = await contract.deployTransaction.wait(confirmations);
  return {
    contract,
    record: {
      address: contract.address,
      transactionHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice?.toString() || null,
      transactionCostWei: receipt.effectiveGasPrice
        ? receipt.gasUsed.mul(receipt.effectiveGasPrice).toString()
        : null,
      confirmations,
    },
  };
}

async function main() {
  const configPath = path.resolve(process.argv[2] || DEFAULT_CONFIG_PATH);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const amoyUrl = required("POLYGON_RPC_URL");
  const sepoliaUrl = required("SEPOLIA_RPC_URL");
  const amoy = new ethers.providers.StaticJsonRpcProvider(amoyUrl, {
    chainId: config.serviceChain.chainId,
    name: config.serviceChain.name,
  });
  const sepolia = new ethers.providers.StaticJsonRpcProvider(sepoliaUrl, {
    chainId: config.settlementChain.chainId,
    name: config.settlementChain.name,
  });
  await Promise.all([amoy.getBlockNumber(), sepolia.getBlockNumber()]);
  const { keyName, privateKey } = deploymentKey();
  const amoyWallet = new ethers.Wallet(privateKey, amoy);
  const sepoliaWallet = new ethers.Wallet(privateKey, sepolia);
  if (amoyWallet.address !== sepoliaWallet.address) {
    throw new Error("deployment address differs across chains");
  }
  const endpointAddress = new ethers.Wallet(required("ENDPOINT_PRIVATE_KEY")).address;
  const fundsReleaseAuthority = ethers.utils.getAddress(required("GATEWAY_RELEASE_AUTHORITY"));
  if (fundsReleaseAuthority === ethers.constants.AddressZero) throw new Error("release authority is zero");
  const [amoyNonce, sepoliaNonce, amoyBalance, sepoliaBalance] = await Promise.all([
    amoy.getTransactionCount(amoyWallet.address, "pending"),
    sepolia.getTransactionCount(sepoliaWallet.address, "pending"),
    amoy.getBalance(amoyWallet.address),
    sepolia.getBalance(sepoliaWallet.address),
  ]);
  const predicted = {
    verifier: predictedAddress(amoyWallet.address, amoyNonce),
    registry: predictedAddress(amoyWallet.address, amoyNonce + 1),
    poseidon2: predictedAddress(sepoliaWallet.address, sepoliaNonce),
    poseidon6: predictedAddress(sepoliaWallet.address, sepoliaNonce + 1),
    escrow: predictedAddress(sepoliaWallet.address, sepoliaNonce + 2),
  };
  const domainHash = settlementDomainHash({
    serviceChainId: config.serviceChain.chainId,
    serviceRegistry: predicted.registry,
    settlementChainId: config.settlementChain.chainId,
    settlementContract: predicted.escrow,
  });
  const outputDirectory = path.join(
    PROJECT_ROOT,
    "experiments/v2/results",
    config.campaignId
  );
  fs.mkdirSync(outputDirectory, { recursive: true });
  const plan = {
    schemaVersion: 1,
    campaignId: config.campaignId,
    generatedAt: new Date().toISOString(),
    execute: process.env.ALLOW_TESTNET_DEPLOYMENT === "1",
    deployerKeyName: keyName,
    deployerAddress: amoyWallet.address,
    endpointAddress,
    fundsReleaseAuthority,
    balancesWei: {
      polygonAmoy: amoyBalance.toString(),
      sepolia: sepoliaBalance.toString(),
    },
    startingNonces: { polygonAmoy: amoyNonce, sepolia: sepoliaNonce },
    predicted,
    settlementDomainHash: domainHash,
    sourceCommit: commandOutput("git", ["rev-parse", "HEAD"], PROJECT_ROOT),
    trackedStatus:
      commandOutput(
        "git",
        ["status", "--porcelain", "--untracked-files=no"],
        PROJECT_ROOT
      ) || "",
    configSha256: sha256File(configPath),
  };
  writeJson(path.join(outputDirectory, "deployment_plan.json"), plan);
  console.log(JSON.stringify(plan, null, 2));
  if (process.env.ALLOW_TESTNET_DEPLOYMENT !== "1") {
    console.log("PLAN ONLY: set ALLOW_TESTNET_DEPLOYMENT=1 after approval");
    return;
  }
  if (plan.trackedStatus) {
    throw new Error("refusing deployment from a dirty tracked worktree");
  }
  const manifestPath = path.join(outputDirectory, "deployment_manifest.json");
  if (fs.existsSync(manifestPath)) {
    throw new Error("deployment manifest already exists; refusing duplicate deployment");
  }

  const amoyFees = await feeOverrides(amoy, config.serviceChain.chainId);
  const sepoliaFees = await feeOverrides(sepolia, config.settlementChain.chainId);
  const VerifierArtifact = await artifacts.readArtifact(
    "ZkCrossAgentBatchVerifierV2"
  );
  const RegistryArtifact = await artifacts.readArtifact("BatchRegistryV2");
  const EscrowArtifact = await artifacts.readArtifact("EscrowReceiptV2");
  const verifierFactory = new ethers.ContractFactory(
    VerifierArtifact.abi,
    VerifierArtifact.bytecode,
    amoyWallet
  );
  const registryFactory = new ethers.ContractFactory(
    RegistryArtifact.abi,
    RegistryArtifact.bytecode,
    amoyWallet
  );
  const escrowFactory = new ethers.ContractFactory(
    EscrowArtifact.abi,
    EscrowArtifact.bytecode,
    sepoliaWallet
  );
  const poseidon2Factory = new ethers.ContractFactory(
    poseidonContract.generateABI(2),
    poseidonContract.createCode(2),
    sepoliaWallet
  );
  const poseidon6Factory = new ethers.ContractFactory(
    poseidonContract.generateABI(6),
    poseidonContract.createCode(6),
    sepoliaWallet
  );
  const deployments = {};
  const persist = () =>
    writeJson(manifestPath, {
      ...plan,
      execute: true,
      deployments,
    });

  let result = await deploy(
    verifierFactory,
    [],
    { nonce: amoyNonce, ...amoyFees },
    config.serviceChain.deploymentConfirmations
  );
  deployments.verifier = result.record;
  if (result.contract.address !== predicted.verifier) throw new Error("verifier prediction mismatch");
  persist();

  result = await deploy(
    poseidon2Factory,
    [],
    { nonce: sepoliaNonce, ...sepoliaFees },
    config.settlementChain.deploymentConfirmations
  );
  deployments.poseidon2 = result.record;
  if (result.contract.address !== predicted.poseidon2) throw new Error("poseidon2 prediction mismatch");
  persist();

  result = await deploy(
    poseidon6Factory,
    [],
    { nonce: sepoliaNonce + 1, ...sepoliaFees },
    config.settlementChain.deploymentConfirmations
  );
  deployments.poseidon6 = result.record;
  if (result.contract.address !== predicted.poseidon6) throw new Error("poseidon6 prediction mismatch");
  persist();

  result = await deploy(
    escrowFactory,
    [
      domainHash,
      endpointAddress,
      config.serviceChain.chainId,
      predicted.registry,
      predicted.poseidon2,
      predicted.poseidon6,
      fundsReleaseAuthority,
    ],
    { nonce: sepoliaNonce + 2, ...sepoliaFees },
    config.settlementChain.deploymentConfirmations
  );
  deployments.escrow = result.record;
  if (result.contract.address !== predicted.escrow) throw new Error("escrow prediction mismatch");
  persist();

  result = await deploy(
    registryFactory,
    [
      predicted.verifier,
      domainHash,
      config.settlementChain.chainId,
      predicted.escrow,
    ],
    { nonce: amoyNonce + 1, ...amoyFees },
    config.serviceChain.deploymentConfirmations
  );
  deployments.registry = result.record;
  if (result.contract.address !== predicted.registry) throw new Error("registry prediction mismatch");

  const escrow = new ethers.Contract(predicted.escrow, EscrowArtifact.abi, sepolia);
  const registry = new ethers.Contract(predicted.registry, RegistryArtifact.abi, amoy);
  const checks = {
    escrowSourceRegistry: await escrow.sourceRegistry(),
    escrowTrustedEndpoint: await escrow.trustedEndpoint(),
    escrowDomainHash: await escrow.settlementDomainHash(),
    registryVerifier: await registry.verifier(),
    registrySettlementContract: await registry.settlementContract(),
    registryDomainHash: await registry.settlementDomainHash(),
  };
  if (
    checks.escrowSourceRegistry.toLowerCase() !== predicted.registry.toLowerCase() ||
    checks.escrowTrustedEndpoint.toLowerCase() !== endpointAddress.toLowerCase() ||
    checks.escrowDomainHash.toLowerCase() !== domainHash.toLowerCase() ||
    checks.registryVerifier.toLowerCase() !== predicted.verifier.toLowerCase() ||
    checks.registrySettlementContract.toLowerCase() !== predicted.escrow.toLowerCase() ||
    checks.registryDomainHash.toLowerCase() !== domainHash.toLowerCase()
  ) {
    throw new Error("deployed immutable binding check failed");
  }
  writeJson(manifestPath, {
    ...plan,
    execute: true,
    completedAt: new Date().toISOString(),
    deployments,
    checks,
  });
  console.log(`PASS v2 deployment: ${manifestPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

require("dotenv").config();

const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers, artifacts } = require("hardhat");
const snarkjs = require("snarkjs");
const { buildPoseidon } = require("circomlibjs");
const {
  PROTOCOL_VERSION,
  ROOT_CAPABILITY_TYPES,
  RECEIPT_TYPES,
  CALLER_CONFIRMATION_TYPES,
  eip712Domain,
  rootCapabilityTypedValue,
  callerConfirmation,
  computeRootCapabilityCommitment,
  computeChildCapabilityCommitment,
  computeReceiptCommitment,
  buildCircuitInput,
} = require("../../lib/protocol-v2");
const {
  commandOutput,
  nowMilliseconds,
  sha256File,
  summarize,
  writeCsv,
  writeJson,
  writeJsonLines,
} = require("../../lib/v2/experiment-utils");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const DEFAULT_CONFIG_PATH = path.join(
  PROJECT_ROOT,
  "experiments/v2/configs/submission-testnet-20261015.json"
);
const WASM_PATH = path.join(
  PROJECT_ROOT,
  "circuits/v2/build/zk_crossagent_v2_js/zk_crossagent_v2.wasm"
);
const ZKEY_PATH = path.join(
  PROJECT_ROOT,
  "circuits/v2/setup/zk_crossagent_v2_final.zkey"
);
const VKEY_PATH = path.join(
  PROJECT_ROOT,
  "circuits/v2/evidence/verification_key.json"
);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function hash(label) {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(label));
}

async function feeOverrides(provider, chainId) {
  const feeData = await provider.getFeeData();
  if (chainId === 80002) {
    const priorityFloor = ethers.utils.parseUnits("30", "gwei");
    const maxFloor = ethers.utils.parseUnits("60", "gwei");
    return {
      maxPriorityFeePerGas:
        feeData.maxPriorityFeePerGas?.gt(priorityFloor)
          ? feeData.maxPriorityFeePerGas
          : priorityFloor,
      maxFeePerGas: feeData.maxFeePerGas?.gt(maxFloor)
        ? feeData.maxFeePerGas
        : maxFloor,
    };
  }
  if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
    return {
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
    };
  }
  return { gasPrice: await provider.getGasPrice() };
}

async function waitMeasured(transaction, confirmations) {
  const sentAt = nowMilliseconds();
  const inclusion = await transaction.wait(1);
  const includedAt = nowMilliseconds();
  const finalized = confirmations > 1
    ? await transaction.wait(confirmations)
    : inclusion;
  const finalizedAt = nowMilliseconds();
  return {
    receipt: finalized,
    inclusionMs: includedAt - sentAt,
    finalityMs: finalizedAt - sentAt,
    confirmationDepth: confirmations,
    gasUsed: inclusion.gasUsed.toNumber(),
    effectiveGasPrice: inclusion.effectiveGasPrice?.toString() || null,
    blockNumber: inclusion.blockNumber,
    transactionHash: transaction.hash,
  };
}

function summarizeRows(rows, campaignId) {
  const metrics = [
    "proveMs",
    "registerBatchGas",
    "registerBatchInclusionMs",
    "registerBatchFinalityMs",
    "relayAcceptGas",
    "relayAcceptInclusionMs",
    "relayAcceptFinalityMs",
    "settleGas",
    "settleInclusionMs",
    "settleFinalityMs",
    "crossChainFinalityMs",
    "endToEndMs",
  ];
  return metrics.map((metric) => ({
    campaignId,
    metric,
    ...summarize(rows.filter((row) => !row.warmup).map((row) => row[metric])),
  }));
}

async function main() {
  if (process.env.ALLOW_TESTNET_BENCHMARK !== "1") {
    throw new Error(
      "public-testnet transactions are disabled; set ALLOW_TESTNET_BENCHMARK=1 only after explicit approval"
    );
  }
  const configPath = path.resolve(process.argv[2] || DEFAULT_CONFIG_PATH);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  for (const artifact of [WASM_PATH, ZKEY_PATH, VKEY_PATH]) {
    if (!fs.existsSync(artifact)) throw new Error(`missing artifact: ${artifact}`);
  }
  const outputDirectory = path.join(
    PROJECT_ROOT,
    "experiments/v2/results",
    config.campaignId
  );
  const deploymentPath = path.join(outputDirectory, "deployment_manifest.json");
  if (!fs.existsSync(deploymentPath)) throw new Error("deployment manifest is missing");
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  if (!deployment.completedAt) throw new Error("v2 deployment is incomplete");
  const trackedStatus =
    commandOutput(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      PROJECT_ROOT
    ) || "";
  if (trackedStatus) throw new Error("refusing testnet benchmark from dirty tracked worktree");

  const amoy = new ethers.providers.StaticJsonRpcProvider(
    required("POLYGON_RPC_URL"),
    { chainId: config.serviceChain.chainId, name: config.serviceChain.name }
  );
  const sepolia = new ethers.providers.StaticJsonRpcProvider(
    required("SEPOLIA_RPC_URL"),
    { chainId: config.settlementChain.chainId, name: config.settlementChain.name }
  );
  await Promise.all([amoy.getBlockNumber(), sepolia.getBlockNumber()]);
  const deployerKeyName = process.env.TESTNET_DEPLOYER_KEY_NAME || "GATEWAY_PRIVATE_KEY";
  const deployerAmoy = new ethers.Wallet(required(deployerKeyName), amoy);
  const deployerSepolia = new ethers.Wallet(required(deployerKeyName), sepolia);
  const endpoint = new ethers.Wallet(required("ENDPOINT_PRIVATE_KEY"), sepolia);
  const payer = new ethers.Wallet(required("TRUSTED_ISSUER_PRIVATE_KEY"), sepolia);
  const buyer = new ethers.Wallet(required("BUYER_PRIVATE_KEY"), sepolia);
  const provider = deployerSepolia;
  const orchestrator = endpoint;
  const RegistryArtifact = await artifacts.readArtifact("BatchRegistryV2");
  const EscrowArtifact = await artifacts.readArtifact("EscrowReceiptV2");
  const registry = new ethers.Contract(
    deployment.predicted.registry,
    RegistryArtifact.abi,
    deployerAmoy
  );
  const escrow = new ethers.Contract(
    deployment.predicted.escrow,
    EscrowArtifact.abi,
    deployerSepolia
  );
  const escrowEndpoint = escrow.connect(endpoint);
  const escrowPayer = escrow.connect(payer);
  const poseidon = await buildPoseidon();
  const verificationKey = JSON.parse(fs.readFileSync(VKEY_PATH, "utf8"));
  const eipDomain = eip712Domain(
    config.settlementChain.chainId,
    deployment.predicted.escrow
  );
  const latest = await sepolia.getBlock("latest");
  const statePath = path.join(outputDirectory, "testnet_v2_state.json");
  const checkpointPath = path.join(outputDirectory, "testnet_v2_checkpoint.jsonl");
  const priorState = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, "utf8"))
    : null;
  const totalRounds =
    config.benchmark.warmupRounds + config.benchmark.measuredRounds;
  const root = {
    protocolVersion: PROTOCOL_VERSION,
    issuer: payer.address,
    payer: payer.address,
    buyer: buyer.address,
    taskId: hash(`${config.campaignId}:task`),
    permissions: 7,
    budget: totalRounds * 10,
    expiry: priorState?.rootExpiry || latest.timestamp + 86400,
    maxSubcalls: totalRounds,
    nonce: 20260801,
    scopeHash: hash(`${config.campaignId}:scope`),
    settlementDomainHash: deployment.settlementDomainHash,
    capabilityCommitment: "0",
  };
  root.capabilityCommitment = computeRootCapabilityCommitment(poseidon, root).toString();
  if (!priorState) {
    writeJson(statePath, {
      rootExpiry: root.expiry,
      rootCommitment: root.capabilityCommitment,
    });
  } else if (priorState.rootCommitment !== root.capabilityCommitment) {
    throw new Error("persisted benchmark root does not match reconstructed root");
  }
  const rootSignature = await payer._signTypedData(
    eipDomain,
    ROOT_CAPABILITY_TYPES,
    rootCapabilityTypedValue(root)
  );
  const sepoliaFees = await feeOverrides(sepolia, config.settlementChain.chainId);
  const amoyFees = await feeOverrides(amoy, config.serviceChain.chainId);
  const setupRows = [];
  const existingRoot = await escrow.getRootRecord(root.capabilityCommitment);
  let transaction;
  let measured;
  if (!existingRoot.exists) {
    transaction = await escrow.registerRootCapability(root, rootSignature, sepoliaFees);
    measured = await waitMeasured(transaction, config.settlementChain.finalityConfirmations);
    setupRows.push({ operation: "register_root_capability", ...measured });
  } else {
    setupRows.push({ operation: "register_root_capability", skippedExisting: true });
  }
  const currentEscrowBalance = await escrow.escrowBalance(payer.address);
  if (currentEscrowBalance.lt(root.budget)) {
    transaction = await escrowPayer.depositFor(payer.address, {
      value: ethers.BigNumber.from(root.budget).sub(currentEscrowBalance),
      ...sepoliaFees,
    });
    measured = await waitMeasured(transaction, config.settlementChain.finalityConfirmations);
    setupRows.push({ operation: "deposit_for", ...measured });
  } else {
    setupRows.push({ operation: "deposit_for", skippedExisting: true });
  }

  const rawRows = fs.existsSync(checkpointPath)
    ? fs.readFileSync(checkpointPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : [];
  for (let index = rawRows.length; index < totalRounds; index += 1) {
    const round = index + 1;
    const warmup = index < config.benchmark.warmupRounds;
    const epoch = 10_000 + round;
    const createdAt = (await sepolia.getBlock("latest")).timestamp;
    const keyReveal = hash(`${config.campaignId}:key:${round}`);
    const child = {
      protocolVersion: PROTOCOL_VERSION,
      issuer: root.issuer,
      buyer: root.buyer,
      provider: provider.address,
      parentCommitment: root.capabilityCommitment,
      taskId: root.taskId,
      permissions: 3,
      budget: 8,
      expiry: root.expiry - 60,
      maxSubcalls: 1,
      nonce: 30_000 + round,
      scopeHash: root.scopeHash,
      settlementDomainHash: root.settlementDomainHash,
    };
    child.capabilityCommitment = computeChildCapabilityCommitment(poseidon, child).toString();
    const receipt = {
      protocolVersion: PROTOCOL_VERSION,
      identity: {
        callId: hash(`${config.campaignId}:call:${round}`),
        taskId: root.taskId,
        rootCommitment: root.capabilityCommitment,
        childCommitment: child.capabilityCommitment,
        payer: payer.address,
        buyer: buyer.address,
        orchestrator: orchestrator.address,
        provider: provider.address,
      },
      delivery: {
        requestHash: hash(`${config.campaignId}:request:${round}`),
        responseHash: hash(`${config.campaignId}:response:${round}`),
        ciphertextHash: hash(`${config.campaignId}:ciphertext:${round}`),
        keyCommitment: ethers.utils.keccak256(keyReveal),
      },
      economics: {
        providerAmount: 8,
        orchestratorFee: 2,
        createdAt,
        settlementDomainHash: root.settlementDomainHash,
      },
    };
    receipt.receiptCommitment = computeReceiptCommitment(poseidon, receipt).toString();
    const built = buildCircuitInput(poseidon, [{ root, child, receipt }], {
      settlementDomainHash: root.settlementDomainHash,
      batchEpoch: epoch,
    });
    const proveStarted = nowMilliseconds();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      built.input,
      WASM_PATH,
      ZKEY_PATH
    );
    const proveMs = nowMilliseconds() - proveStarted;
    if (!(await snarkjs.groth16.verify(verificationKey, publicSignals, proof))) {
      throw new Error("testnet proof failed off-chain verification");
    }
    if (BigInt(publicSignals[0]) !== built.expectedBatchRoot) {
      throw new Error("testnet proof root mismatch");
    }
    const calldata = JSON.parse(
      `[${await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)}]`
    );
    const roundStarted = nowMilliseconds();
    transaction = await registry.registerBatchProof(
      epoch,
      1,
      built.expectedBatchRoot.toString(),
      calldata[0],
      calldata[1],
      calldata[2],
      amoyFees
    );
    const registered = await waitMeasured(
      transaction,
      config.serviceChain.finalityConfirmations
    );
    const batchKeyRegistry = await registry.computeBatchKey(
      epoch,
      built.expectedBatchRoot.toString()
    );
    const batchKeyEscrow = await escrow.computeBatchKey(
      epoch,
      built.expectedBatchRoot.toString()
    );
    if (batchKeyRegistry.toLowerCase() !== batchKeyEscrow.toLowerCase()) {
      throw new Error("cross-chain batch key mismatch");
    }
    transaction = await escrowEndpoint.acceptBatchRoot(
      epoch,
      1,
      built.expectedBatchRoot.toString(),
      registered.blockNumber,
      registered.transactionHash,
      sepoliaFees
    );
    const relayed = await waitMeasured(
      transaction,
      config.settlementChain.finalityConfirmations
    );
    const providerSignature = await provider._signTypedData(
      eipDomain,
      RECEIPT_TYPES,
      receipt
    );
    const buyerSignature = await buyer._signTypedData(
      eipDomain,
      CALLER_CONFIRMATION_TYPES,
      callerConfirmation(receipt, providerSignature)
    );
    transaction = await escrow.settleReceipt(
      receipt,
      providerSignature,
      buyerSignature,
      keyReveal,
      batchKeyEscrow,
      0,
      built.tree.proof(0).map(String),
      sepoliaFees
    );
    const settled = await waitMeasured(
      transaction,
      config.settlementChain.finalityConfirmations
    );
    rawRows.push({
      schemaVersion: 1,
      recordType: "testnet_v2_round",
      campaignId: config.campaignId,
      round,
      warmup,
      epoch,
      realCount: 1,
      proveMs,
      registerBatchGas: registered.gasUsed,
      registerBatchInclusionMs: registered.inclusionMs,
      registerBatchFinalityMs: registered.finalityMs,
      registerBatchTransactionHash: registered.transactionHash,
      registerBatchBlockNumber: registered.blockNumber,
      relayAcceptGas: relayed.gasUsed,
      relayAcceptInclusionMs: relayed.inclusionMs,
      relayAcceptFinalityMs: relayed.finalityMs,
      relayAcceptTransactionHash: relayed.transactionHash,
      settleGas: settled.gasUsed,
      settleInclusionMs: settled.inclusionMs,
      settleFinalityMs: settled.finalityMs,
      settleTransactionHash: settled.transactionHash,
      crossChainFinalityMs: registered.finalityMs + relayed.finalityMs,
      endToEndMs: nowMilliseconds() - roundStarted + proveMs,
      batchKey: batchKeyEscrow,
      outcome: "success",
    });
    writeJsonLines(checkpointPath, rawRows);
    console.log(`PASS testnet round ${round}/${totalRounds}`);
  }

  const summary = summarizeRows(rawRows, config.campaignId);
  const rawPath = path.join(outputDirectory, "testnet_v2_raw.jsonl");
  const summaryJsonPath = path.join(outputDirectory, "testnet_v2_summary.json");
  const summaryCsvPath = path.join(outputDirectory, "testnet_v2_summary.csv");
  writeJsonLines(rawPath, rawRows);
  writeJson(summaryJsonPath, summary);
  writeCsv(summaryCsvPath, summary);
  const manifest = {
    schemaVersion: 1,
    campaignId: config.campaignId,
    campaignClass: config.campaignClass,
    generatedAt: new Date().toISOString(),
    configPath: path.relative(PROJECT_ROOT, configPath),
    configSha256: sha256File(configPath),
    sourceCommit: commandOutput("git", ["rev-parse", "HEAD"], PROJECT_ROOT),
    trackedStatus,
    host: { platform: os.platform(), release: os.release(), architecture: os.arch() },
    addresses: deployment.predicted,
    settlementDomainHash: deployment.settlementDomainHash,
    setupTransactions: setupRows,
    files: {},
  };
  for (const filePath of [rawPath, summaryJsonPath, summaryCsvPath, deploymentPath]) {
    manifest.files[path.basename(filePath)] = {
      sha256: sha256File(filePath),
      sizeBytes: fs.statSync(filePath).size,
    };
  }
  writeJson(path.join(outputDirectory, "testnet_v2_manifest.json"), manifest);
  fs.rmSync(checkpointPath, { force: true });
  fs.rmSync(statePath, { force: true });
  console.log(`PASS testnet v2 campaign: ${rawRows.length} rounds`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

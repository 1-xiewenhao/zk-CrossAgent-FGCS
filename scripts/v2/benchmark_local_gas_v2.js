const fs = require("fs");
const path = require("path");
const { ethers, artifacts } = require("hardhat");
const { buildPoseidon, poseidonContract } = require("circomlibjs");
const assert = require("assert");
const { ROOT_BUDGET_RELEASE_TYPES } = require("../../lib/v2/escrow-withdrawal");
const {
  PROTOCOL_VERSION,
  ROOT_CAPABILITY_TYPES,
  RECEIPT_TYPES,
  CALLER_CONFIRMATION_TYPES,
  eip712Domain,
  rootCapabilityTypedValue,
  settlementDomainHash,
  computeRootCapabilityCommitment,
  computeChildCapabilityCommitment,
  computeReceiptCommitment,
  computeRealLeaf,
  buildMerkleTree,
  callerConfirmation,
} = require("../../lib/protocol-v2");
const {
  commandOutput,
  sha256File,
  summarize,
  writeCsv,
  writeJson,
  writeJsonLines,
} = require("../../lib/v2/experiment-utils");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const DEFAULT_CONFIG_PATH = path.join(
  PROJECT_ROOT,
  "experiments/v2/configs/submission-fault-gas-20261015.json"
);
const CALLDATA_PATH = path.join(
  PROJECT_ROOT,
  "circuits/v2/evidence/solidity_calldata.txt"
);

async function deployPoseidon(inputCount, signer) {
  const factory = new ethers.ContractFactory(
    poseidonContract.generateABI(inputCount),
    poseidonContract.createCode(inputCount),
    signer
  );
  const contract = await factory.deploy();
  await contract.deployed();
  return contract;
}

function hash(label) {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(label));
}

async function main() {
  const configPath = path.resolve(
    process.env.EXPERIMENT_CONFIG || process.argv[2] || DEFAULT_CONFIG_PATH
  );
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const outputDirectory = path.resolve(
    process.env.EXPERIMENT_OUTPUT ||
      path.join(PROJECT_ROOT, "experiments/v2/results", config.campaignId)
  );
  fs.mkdirSync(outputDirectory, { recursive: true });
  const [deployer, endpoint, payer, buyer, provider, orchestrator, sourceRegistry] =
    await ethers.getSigners();
  const poseidon = await buildPoseidon();
  const poseidon2 = await deployPoseidon(2, deployer);
  const poseidon6 = await deployPoseidon(6, deployer);
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const predictedEscrowAddress = ethers.utils.getContractAddress({
    from: deployer.address,
    nonce: await deployer.getTransactionCount(),
  });
  const domainHash = settlementDomainHash({
    serviceChainId: 80002,
    serviceRegistry: sourceRegistry.address,
    settlementChainId: chainId,
    settlementContract: predictedEscrowAddress,
  });
  const EscrowReceiptV2 = await ethers.getContractFactory("EscrowReceiptV2");
  const escrow = await EscrowReceiptV2.deploy(
    domainHash,
    endpoint.address,
    80002,
    sourceRegistry.address,
    poseidon2.address,
    poseidon6.address,
    deployer.address
  );
  const escrowDeployment = await escrow.deployTransaction.wait();
  const Verifier = await ethers.getContractFactory(
    "ZkCrossAgentBatchVerifierV2"
  );
  const verifier = await Verifier.deploy();
  const verifierDeployment = await verifier.deployTransaction.wait();
  const domain = eip712Domain(chainId, escrow.address);
  const latest = await ethers.provider.getBlock("latest");
  const rounds = config.localGas.settlementRounds;
  const root = {
    protocolVersion: PROTOCOL_VERSION,
    issuer: payer.address,
    payer: payer.address,
    buyer: buyer.address,
    taskId: hash("phase-e-gas-root"),
    permissions: 7,
    budget: rounds * 10,
    expiry: latest.timestamp + 3600,
    maxSubcalls: rounds,
    nonce: 1,
    scopeHash: hash("phase-e-gas-scope"),
    settlementDomainHash: domainHash,
    capabilityCommitment: "0",
  };
  root.capabilityCommitment = computeRootCapabilityCommitment(
    poseidon,
    root
  ).toString();
  const rootSignature = await payer._signTypedData(
    domain,
    ROOT_CAPABILITY_TYPES,
    rootCapabilityTypedValue(root)
  );
  const rawRows = [
    {
      schemaVersion: 1,
      recordType: "local_gas_sample",
      campaignId: config.campaignId,
      operation: "deploy_escrow_v2",
      round: 1,
      gasUsed: escrowDeployment.gasUsed.toNumber(),
    },
    {
      schemaVersion: 1,
      recordType: "local_gas_sample",
      campaignId: config.campaignId,
      operation: "deploy_groth16_verifier_v2",
      round: 1,
      gasUsed: verifierDeployment.gasUsed.toNumber(),
    },
  ];

  let transaction = await escrow.registerRootCapability(root, rootSignature);
  let receiptValue = await transaction.wait();
  rawRows.push({
    schemaVersion: 1,
    recordType: "local_gas_sample",
    campaignId: config.campaignId,
    operation: "register_root_capability",
    round: 1,
    gasUsed: receiptValue.gasUsed.toNumber(),
  });
  transaction = await escrow.connect(payer).depositFor(payer.address, {
    value: root.budget,
  });
  receiptValue = await transaction.wait();
  rawRows.push({
    schemaVersion: 1,
    recordType: "local_gas_sample",
    campaignId: config.campaignId,
    operation: "deposit_for",
    round: 1,
    gasUsed: receiptValue.gasUsed.toNumber(),
  });

  const items = [];
  for (let index = 0; index < rounds; index += 1) {
    const keyReveal = ethers.utils.hexlify(
      ethers.utils.arrayify(hash(`phase-e-key-${index}`))
    );
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
      nonce: 100 + index,
      scopeHash: root.scopeHash,
      settlementDomainHash: domainHash,
    };
    const receipt = {
      protocolVersion: PROTOCOL_VERSION,
      identity: {
        callId: hash(`phase-e-call-${index}`),
        taskId: root.taskId,
        rootCommitment: root.capabilityCommitment,
        childCommitment: computeChildCapabilityCommitment(
          poseidon,
          child
        ).toString(),
        payer: payer.address,
        buyer: buyer.address,
        orchestrator: orchestrator.address,
        provider: provider.address,
      },
      delivery: {
        requestHash: hash(`phase-e-request-${index}`),
        responseHash: hash(`phase-e-response-${index}`),
        ciphertextHash: hash(`phase-e-ciphertext-${index}`),
        keyCommitment: ethers.utils.keccak256(keyReveal),
      },
      economics: {
        providerAmount: 8,
        orchestratorFee: 2,
        createdAt: latest.timestamp,
        settlementDomainHash: domainHash,
      },
      receiptCommitment: "0",
    };
    receipt.receiptCommitment = computeReceiptCommitment(
      poseidon,
      receipt
    ).toString();
    const providerSignature = await provider._signTypedData(
      domain,
      RECEIPT_TYPES,
      receipt
    );
    const buyerSignature = await buyer._signTypedData(
      domain,
      CALLER_CONFIRMATION_TYPES,
      callerConfirmation(receipt, providerSignature)
    );
    items.push({
      receipt,
      providerSignature,
      buyerSignature,
      keyReveal,
      leaf: computeRealLeaf(poseidon, receipt.receiptCommitment),
    });
  }

  const tree = buildMerkleTree(
    poseidon,
    items.map((item) => item.leaf)
  );
  for (let index = 0; index < config.localGas.batchRootRounds; index += 1) {
    const epoch = index + 1;
    const batchRoot = index === 0 ? tree.root : BigInt(10_000 + index);
    transaction = await escrow
      .connect(endpoint)
      .acceptBatchRoot(
        epoch,
        index === 0 ? items.length : 1,
        batchRoot.toString(),
        123_456 + index,
        hash(`phase-e-source-${index}`)
      );
    receiptValue = await transaction.wait();
    rawRows.push({
      schemaVersion: 1,
      recordType: "local_gas_sample",
      campaignId: config.campaignId,
      operation: "accept_batch_root",
      round: epoch,
      gasUsed: receiptValue.gasUsed.toNumber(),
    });
  }
  const batchKey = await escrow.computeBatchKey(1, tree.root.toString());
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    transaction = await escrow.settleReceipt(
      item.receipt,
      item.providerSignature,
      item.buyerSignature,
      item.keyReveal,
      batchKey,
      index,
      tree.proof(index).map(String)
    );
    receiptValue = await transaction.wait();
    rawRows.push({
      schemaVersion: 1,
      recordType: "local_gas_sample",
      campaignId: config.campaignId,
      operation: "settle_receipt",
      round: index + 1,
      gasUsed: receiptValue.gasUsed.toNumber(),
    });
  }

  const calldata = JSON.parse(
    `[${fs.readFileSync(CALLDATA_PATH, "utf8").trim()}]`
  );
  const populated = await verifier.populateTransaction.verifyProof(...calldata);
  for (let index = 0; index < config.localGas.verifierRounds; index += 1) {
    const estimate = await ethers.provider.estimateGas({
      from: deployer.address,
      to: verifier.address,
      data: populated.data,
    });
    transaction = await deployer.sendTransaction({
      to: verifier.address,
      data: populated.data,
      gasLimit: estimate.mul(12).div(10),
    });
    receiptValue = await transaction.wait();
    rawRows.push({
      schemaVersion: 1,
      recordType: "local_gas_sample",
      campaignId: config.campaignId,
      operation: "verify_groth16_batch",
      round: index + 1,
      estimateGas: estimate.toNumber(),
      gasUsed: receiptValue.gasUsed.toNumber(),
    });
  }

  // Measure the financial lifecycle separately from receipt-settlement costs.
  // An anchor root keeps both payer storage slots nonzero in these samples.
  const withdrawalRounds = config.localGas.withdrawalRounds || 16;
  const releaseExpiry = (await ethers.provider.getBlock("latest")).timestamp + 3600;
  const financialRoots = [];
  for (let index = 0; index <= withdrawalRounds; index += 1) {
    const financialRoot = { ...root, taskId: hash(`withdrawal-task-${index}`),
      budget: 100, maxSubcalls: 1, expiry: releaseExpiry, nonce: 9000 + index };
    financialRoot.capabilityCommitment = computeRootCapabilityCommitment(poseidon, financialRoot).toString();
    const sig = await payer._signTypedData(domain, ROOT_CAPABILITY_TYPES, rootCapabilityTypedValue(financialRoot));
    await (await escrow.registerRootCapability(financialRoot, sig)).wait();
    await (await escrow.connect(payer).depositFor(payer.address, { value: 100 })).wait();
    financialRoots.push(financialRoot);
  }
  for (let index = 0; index < withdrawalRounds; index += 1) {
    await (await escrow.connect(payer).depositFor(payer.address, { value: 20 })).wait();
    const tx = await escrow.connect(payer).withdraw(20, buyer.address);
    const mined = await tx.wait();
    rawRows.push({ schemaVersion: 1, recordType: "local_gas_sample", campaignId: config.campaignId,
      operation: "withdraw_surplus", round: index + 1, gasUsed: mined.gasUsed.toNumber(),
      recipientType: "EOA", payerBalanceRemainsNonzero: true, protectedBalanceRemainsNonzero: true });
    assert((await escrow.withdrawableBalance(payer.address)).isZero());
  }
  await ethers.provider.send("evm_setNextBlockTimestamp", [releaseExpiry + 1]);
  await ethers.provider.send("evm_mine", []);
  for (let index = 0; index < withdrawalRounds; index += 1) {
    const financialRoot = financialRoots[index];
    const statement = { protocolVersion: PROTOCOL_VERSION, rootCommitment: financialRoot.capabilityCommitment,
      payer: payer.address, settledAmount: 0, settledCalls: 0, validUntil: releaseExpiry + 3600,
      settlementDomainHash: domainHash };
    const authorization = await deployer._signTypedData(domain, ROOT_BUDGET_RELEASE_TYPES, statement);
    const releaseTx = await escrow.releaseUnusedRootBudget(statement.rootCommitment,
      statement.settledAmount, statement.settledCalls, statement.validUntil, authorization);
    const released = await releaseTx.wait();
    rawRows.push({ schemaVersion: 1, recordType: "local_gas_sample", campaignId: config.campaignId,
      operation: "release_unused_root_budget", round: index + 1, gasUsed: released.gasUsed.toNumber(),
      settledCalls: 0, unusedBudget: 100, protectedBalanceRemainsNonzero: true });
    assert.strictEqual((await escrow.withdrawableBalance(payer.address)).toString(), "100");
    const tx = await escrow.connect(payer).withdraw(100, buyer.address);
    const mined = await tx.wait();
    rawRows.push({ schemaVersion: 1, recordType: "local_gas_sample", campaignId: config.campaignId,
      operation: "withdraw_released_budget", round: index + 1, gasUsed: mined.gasUsed.toNumber(),
      recipientType: "EOA", payerBalanceRemainsNonzero: true, protectedBalanceRemainsNonzero: true });
  }
  assert.strictEqual((await escrow.escrowBalance(payer.address)).toString(), "100");
  assert.strictEqual((await escrow.protectedBudget(payer.address)).toString(), "100");
  const operations = [...new Set(rawRows.map((row) => row.operation))];
  const summaries = operations.map((operation) => {
    const values = rawRows
      .filter((row) => row.operation === operation)
      .map((row) => row.gasUsed);
    return {
      campaignId: config.campaignId,
      network: "hardhat-local",
      operation,
      metric: "gasUsed",
      ...summarize(values),
    };
  });
  const rawPath = path.join(outputDirectory, "local_gas_raw.jsonl");
  const summaryJsonPath = path.join(outputDirectory, "local_gas_summary.json");
  const summaryCsvPath = path.join(outputDirectory, "local_gas_summary.csv");
  writeJsonLines(rawPath, rawRows);
  writeJson(summaryJsonPath, summaries);
  writeCsv(summaryCsvPath, summaries);
  const manifestPath = path.join(outputDirectory, "manifest.json");
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : {
        schemaVersion: 1,
        campaignId: config.campaignId,
        files: {},
        modes: {},
      };
  manifest.modes.localGas = "completed";
  manifest.localChain = {
    chainId,
    escrowAddress: escrow.address,
    verifierAddress: verifier.address,
    sourceRegistry: sourceRegistry.address,
  };
  manifest.sourceCommit = commandOutput(
    "git",
    ["rev-parse", "HEAD"],
    PROJECT_ROOT
  );
  for (const filePath of [rawPath, summaryJsonPath, summaryCsvPath]) {
    const name = path.basename(filePath);
    manifest.files[name] = {
      sha256: sha256File(filePath),
      sizeBytes: fs.statSync(filePath).size,
    };
  }
  writeJson(manifestPath, manifest);
  console.log(`PASS local gas campaign: ${rawRows.length} samples`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

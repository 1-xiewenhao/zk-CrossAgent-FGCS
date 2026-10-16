const assert = require("assert");
const { ethers } = require("hardhat");
const { buildPoseidon, poseidonContract } = require("circomlibjs");
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
} = require("../lib/protocol-v2");

async function expectRevert(promise, expectedMessage) {
  let error;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert(error, `Expected transaction to revert with "${expectedMessage}"`);
  assert(
    error.message.includes(expectedMessage),
    `Expected "${expectedMessage}", received: ${error.message}`
  );
}

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

describe("EscrowReceiptV2", function () {
  this.timeout(180_000);

  let deployer;
  let endpoint;
  let payer;
  let buyer;
  let provider;
  let orchestrator;
  let sourceRegistry;
  let attacker;
  let poseidon;
  let escrow;
  let domain;
  let domainHash;
  let chainId;

  beforeEach(async function () {
    [
      deployer,
      endpoint,
      payer,
      buyer,
      provider,
      orchestrator,
      sourceRegistry,
      attacker,
    ] = await ethers.getSigners();

    poseidon = await buildPoseidon();
    const poseidon2 = await deployPoseidon(2, deployer);
    const poseidon6 = await deployPoseidon(6, deployer);

    chainId = (await ethers.provider.getNetwork()).chainId;
    const deployerNonce = await deployer.getTransactionCount();
    const predictedEscrowAddress = ethers.utils.getContractAddress({
      from: deployer.address,
      nonce: deployerNonce,
    });
    domainHash = settlementDomainHash({
      serviceChainId: 80002,
      serviceRegistry: sourceRegistry.address,
      settlementChainId: chainId,
      settlementContract: predictedEscrowAddress,
    });

    const EscrowReceiptV2 = await ethers.getContractFactory("EscrowReceiptV2");
    escrow = await EscrowReceiptV2.connect(deployer).deploy(
      domainHash,
      endpoint.address,
      80002,
      sourceRegistry.address,
      poseidon2.address,
      poseidon6.address,
      deployer.address
    );
    await escrow.deployed();
    assert.strictEqual(
      escrow.address.toLowerCase(),
      predictedEscrowAddress.toLowerCase()
    );
    domain = eip712Domain(chainId, escrow.address);
  });

  async function registerRoot({ budget = 100, maxSubcalls = 4 } = {}) {
    const latest = await ethers.provider.getBlock("latest");
    const root = {
      protocolVersion: PROTOCOL_VERSION,
      issuer: payer.address,
      payer: payer.address,
      buyer: buyer.address,
      taskId: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("task-v2")),
      permissions: 7,
      budget,
      expiry: latest.timestamp + 3600,
      maxSubcalls,
      nonce: 1,
      scopeHash: ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("PUBLIC_MARKET_DATA")
      ),
      settlementDomainHash: domainHash,
      capabilityCommitment: 0,
    };
    root.capabilityCommitment = computeRootCapabilityCommitment(
      poseidon,
      root
    ).toString();
    const signature = await payer._signTypedData(
      domain,
      ROOT_CAPABILITY_TYPES,
      rootCapabilityTypedValue(root)
    );
    await escrow.registerRootCapability(root, signature);
    return root;
  }

  async function createSignedReceipt(root, suffix, amounts = {}) {
    const keyReveal = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const providerAmount = amounts.providerAmount ?? 8;
    const orchestratorFee = amounts.orchestratorFee ?? 2;
    const child = {
      protocolVersion: PROTOCOL_VERSION,
      issuer: root.issuer,
      buyer: root.buyer,
      provider: provider.address,
      parentCommitment: root.capabilityCommitment,
      taskId: root.taskId,
      permissions: 3,
      budget: providerAmount,
      expiry: root.expiry - 60,
      maxSubcalls: 1,
      nonce: Number(suffix) + 100,
      scopeHash: root.scopeHash,
      settlementDomainHash: domainHash,
    };
    const childCommitment = computeChildCapabilityCommitment(
      poseidon,
      child
    );
    const receipt = {
      protocolVersion: PROTOCOL_VERSION,
      identity: {
        callId: ethers.utils.keccak256(
          ethers.utils.toUtf8Bytes(`call-v2-${suffix}`)
        ),
        taskId: root.taskId,
        rootCommitment: root.capabilityCommitment,
        childCommitment: childCommitment.toString(),
        payer: payer.address,
        buyer: buyer.address,
        orchestrator: orchestrator.address,
        provider: provider.address,
      },
      delivery: {
        requestHash: ethers.utils.keccak256(
          ethers.utils.toUtf8Bytes(`request-${suffix}`)
        ),
        responseHash: ethers.utils.keccak256(
          ethers.utils.toUtf8Bytes(`response-${suffix}`)
        ),
        ciphertextHash: ethers.utils.keccak256(
          ethers.utils.toUtf8Bytes(`ciphertext-${suffix}`)
        ),
        keyCommitment: ethers.utils.keccak256(keyReveal),
      },
      economics: {
        providerAmount,
        orchestratorFee,
        createdAt: (await ethers.provider.getBlock("latest")).timestamp,
        settlementDomainHash: domainHash,
      },
      receiptCommitment: 0,
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
    const confirmation = callerConfirmation(receipt, providerSignature);
    const buyerSignature = await buyer._signTypedData(
      domain,
      CALLER_CONFIRMATION_TYPES,
      confirmation
    );
    const leaf = computeRealLeaf(poseidon, receipt.receiptCommitment);

    return {
      receipt,
      providerSignature,
      buyerSignature,
      keyReveal,
      leaf,
    };
  }

  async function acceptBatch(items, epoch = 1) {
    const tree = buildMerkleTree(
      poseidon,
      items.map((item) => item.leaf)
    );
    const sourceTransactionHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(`source-proof-${epoch}`)
    );
    await escrow
      .connect(endpoint)
      .acceptBatchRoot(
        epoch,
        items.length,
        tree.root.toString(),
        123456,
        sourceTransactionHash
      );
    const batchKey = await escrow.computeBatchKey(
      epoch,
      tree.root.toString()
    );
    return { tree, batchKey };
  }

  async function settle(item, batch, index = 0) {
    return escrow.settleReceipt(
      item.receipt,
      item.providerSignature,
      item.buyerSignature,
      item.keyReveal,
      batch.batchKey,
      index,
      batch.tree.proof(index).map(String)
    );
  }

  it("registers a domain-bound root and settles an included dual-signed receipt", async function () {
    const root = await registerRoot();
    await escrow
      .connect(payer)
      .depositFor(payer.address, { value: root.budget });
    const item = await createSignedReceipt(root, "1");
    const batch = await acceptBatch([item]);
    const providerBefore = await ethers.provider.getBalance(provider.address);
    const orchestratorBefore = await ethers.provider.getBalance(
      orchestrator.address
    );

    await settle(item, batch);

    assert.strictEqual(await escrow.isSettled(item.receipt.identity.callId), true);
    assert.strictEqual(
      (await escrow.escrowBalance(payer.address)).toString(),
      "90"
    );
    assert.strictEqual(
      (await ethers.provider.getBalance(provider.address))
        .sub(providerBefore)
        .toString(),
      "8"
    );
    assert.strictEqual(
      (await ethers.provider.getBalance(orchestrator.address))
        .sub(orchestratorBefore)
        .toString(),
      "2"
    );
    const storedRoot = await escrow.getRootRecord(root.capabilityCommitment);
    assert.strictEqual(storedRoot.settledAmount.toString(), "10");
    assert.strictEqual(storedRoot.settledCalls.toString(), "1");

    await expectRevert(settle(item, batch), "EscrowV2: already settled");
  });

  it("rejects an issuer signature from another EIP-712 signer", async function () {
    const latest = await ethers.provider.getBlock("latest");
    const root = {
      protocolVersion: PROTOCOL_VERSION,
      issuer: payer.address,
      payer: payer.address,
      buyer: buyer.address,
      taskId: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("bad-root")),
      permissions: 1,
      budget: 10,
      expiry: latest.timestamp + 3600,
      maxSubcalls: 1,
      nonce: 2,
      scopeHash: ethers.constants.HashZero,
      settlementDomainHash: domainHash,
      capabilityCommitment: 123,
    };
    const signature = await attacker._signTypedData(
      domain,
      ROOT_CAPABILITY_TYPES,
      rootCapabilityTypedValue(root)
    );
    await expectRevert(
      escrow.registerRootCapability(root, signature),
      "RootV2: invalid issuer signature"
    );
  });

  it("accepts roots only from the configured endpoint and rejects duplicates", async function () {
    const rootValue = 12345;
    const sourceTx = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("batch-source")
    );
    await expectRevert(
      escrow
        .connect(attacker)
        .acceptBatchRoot(1, 1, rootValue, 100, sourceTx),
      "InboxV2: untrusted endpoint"
    );
    await escrow
      .connect(endpoint)
      .acceptBatchRoot(1, 1, rootValue, 100, sourceTx);
    await expectRevert(
      escrow
        .connect(endpoint)
        .acceptBatchRoot(1, 1, rootValue, 100, sourceTx),
      "InboxV2: duplicate batch"
    );
  });

  it("rejects invalid key reveals, altered receipts, and forged inclusion proofs", async function () {
    const root = await registerRoot();
    await escrow
      .connect(payer)
      .depositFor(payer.address, { value: root.budget });
    const item = await createSignedReceipt(root, "2");
    const batch = await acceptBatch([item]);

    await expectRevert(
      escrow.settleReceipt(
        item.receipt,
        item.providerSignature,
        item.buyerSignature,
        ethers.constants.HashZero,
        batch.batchKey,
        0,
        batch.tree.proof(0).map(String)
      ),
      "EscrowV2: invalid key reveal"
    );

    const altered = {
      ...item.receipt,
      economics: {
        ...item.receipt.economics,
        providerAmount: 9,
      },
    };
    await expectRevert(
      escrow.settleReceipt(
        altered,
        item.providerSignature,
        item.buyerSignature,
        item.keyReveal,
        batch.batchKey,
        0,
        batch.tree.proof(0).map(String)
      ),
      "EscrowV2: receipt commitment mismatch"
    );

    const forgedProof = batch.tree.proof(0).map(String);
    forgedProof[0] = "1";
    await expectRevert(
      escrow.settleReceipt(
        item.receipt,
        item.providerSignature,
        item.buyerSignature,
        item.keyReveal,
        batch.batchKey,
        0,
        forgedProof
      ),
      "EscrowV2: invalid inclusion proof"
    );
  });

  it("enforces the registered root budget across multiple batch members", async function () {
    const root = await registerRoot({ budget: 15, maxSubcalls: 2 });
    await escrow.connect(payer).depositFor(payer.address, { value: 100 });
    const first = await createSignedReceipt(root, "3");
    const second = await createSignedReceipt(root, "4");
    const batch = await acceptBatch([first, second]);

    await settle(first, batch, 0);
    await expectRevert(
      settle(second, batch, 1),
      "RootV2: budget exceeded"
    );
    assert.strictEqual(
      (await escrow.escrowBalance(payer.address)).toString(),
      "90"
    );
  });
});

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("hardhat");
const { buildPoseidon, poseidonContract } = require("circomlibjs");
const {
  PROTOCOL_VERSION,
  ROOT_CAPABILITY_TYPES,
  CHILD_CAPABILITY_TYPES,
  CALLER_CONFIRMATION_TYPES,
  eip712Domain,
  rootCapabilityTypedValue,
  childCapabilityTypedValue,
  settlementDomainHash,
  computeRootCapabilityCommitment,
  computeChildCapabilityCommitment,
  computeRealLeaf,
  buildMerkleTree,
  callerConfirmation,
} = require("../lib/protocol-v2");
const {
  PersistentProtocolState,
} = require("../lib/v2/persistent-state");
const {
  SecureGatewayV2,
  decryptDelivery,
} = require("../lib/v2/secure-gateway");

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

describe("zk-CrossAgent v2 end-to-end", function () {
  this.timeout(180_000);

  it("recovers after key release and settles the same committed delivery on-chain", async function () {
    const [
      deployer,
      endpoint,
      payer,
      buyer,
      provider,
      orchestrator,
      sourceRegistry,
    ] = await ethers.getSigners();
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
    const EscrowReceiptV2 = await ethers.getContractFactory(
      "EscrowReceiptV2"
    );
    const escrow = await EscrowReceiptV2.connect(deployer).deploy(
      domainHash,
      endpoint.address,
      80002,
      sourceRegistry.address,
      poseidon2.address,
      poseidon6.address,
      deployer.address
    );
    await escrow.deployed();
    const domain = eip712Domain(chainId, escrow.address);
    const latest = await ethers.provider.getBlock("latest");

    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "zk-crossagent-e2e-")
    );
    const databasePath = path.join(temporaryDirectory, "e2e.sqlite");
    const masterKey = crypto.randomBytes(32);
    let state = new PersistentProtocolState(databasePath, {
      clock: () => latest.timestamp,
    });
    let gateway = new SecureGatewayV2({
      state,
      poseidon,
      eip712Domain: domain,
      settlementDomainHash: domainHash,
      providerSigner: provider,
      masterKey,
      clock: () => latest.timestamp,
    });

    try {
      const root = {
        protocolVersion: PROTOCOL_VERSION,
        issuer: payer.address,
        payer: payer.address,
        buyer: buyer.address,
        taskId: hash("e2e-task"),
        permissions: 7,
        budget: 100,
        expiry: latest.timestamp + 3600,
        maxSubcalls: 2,
        nonce: 1,
        scopeHash: hash("e2e-scope"),
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
      gateway.registerRoot(root, rootSignature);
      await escrow.registerRootCapability(root, rootSignature);
      await escrow.connect(payer).depositFor(payer.address, { value: 100 });

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
        nonce: 10,
        scopeHash: root.scopeHash,
        settlementDomainHash: domainHash,
        capabilityCommitment: "0",
      };
      child.capabilityCommitment = computeChildCapabilityCommitment(
        poseidon,
        child
      ).toString();
      const childSignature = await buyer._signTypedData(
        domain,
        CHILD_CAPABILITY_TYPES,
        childCapabilityTypedValue(child)
      );
      const reserved = gateway.reserveAuthorizedCall({
        root,
        child,
        childSignature,
        request: { operation: "classify", input: "network trace" },
        providerAmount: 8,
        orchestratorFee: 2,
        orchestrator: orchestrator.address,
      });
      const committed = await gateway.commitEncryptedResponse(
        reserved.callId,
        "benign"
      );
      const buyerSignature = await buyer._signTypedData(
        domain,
        CALLER_CONFIRMATION_TYPES,
        callerConfirmation(
          committed.receipt,
          committed.providerSignature
        )
      );
      const released = await gateway.confirmAndRelease(
        reserved.callId,
        buyerSignature
      );
      assert.strictEqual(decryptDelivery(released).toString("utf8"), "benign");

      state.close();
      state = new PersistentProtocolState(databasePath, {
        clock: () => latest.timestamp,
      });
      gateway = new SecureGatewayV2({
        state,
        poseidon,
        eip712Domain: domain,
        settlementDomainHash: domainHash,
        providerSigner: provider,
        masterKey,
        clock: () => latest.timestamp,
      });
      assert.strictEqual(state.getCall(reserved.callId).state, "KEY_RELEASED");

      const leaf = computeRealLeaf(
        poseidon,
        committed.receipt.receiptCommitment
      );
      const tree = buildMerkleTree(poseidon, [leaf]);
      state.sealBatch({
        epoch: 1,
        batchRoot: tree.root,
        callIds: [reserved.callId],
      });
      state.markProved(reserved.callId);
      const sourceTransactionHash = hash("e2e-source-proof");
      await escrow
        .connect(endpoint)
        .acceptBatchRoot(
          1,
          1,
          tree.root.toString(),
          123456,
          sourceTransactionHash
        );
      state.markRootRelayed(reserved.callId);
      const batchKey = await escrow.computeBatchKey(1, tree.root.toString());

      const settlementTransaction = await escrow.settleReceipt(
        committed.receipt,
        committed.providerSignature,
        buyerSignature,
        released.keyReveal,
        batchKey,
        0,
        tree.proof(0).map(String)
      );
      state.markSettling(reserved.callId, settlementTransaction.hash);
      await settlementTransaction.wait();
      state.markSettled(reserved.callId);

      assert.strictEqual(
        await escrow.isSettled(committed.receipt.identity.callId),
        true
      );
      const onchainRoot = await escrow.getRootRecord(root.capabilityCommitment);
      const durableRoot = state.getRoot(root.capabilityCommitment);
      assert.strictEqual(onchainRoot.settledAmount.toString(), "10");
      assert.strictEqual(durableRoot.settledAmount, 10n);
      assert.strictEqual(durableRoot.reservedAmount, 0n);
      assert.strictEqual(state.getCall(reserved.callId).state, "SETTLED");
      assert.strictEqual(state.assertRootInvariant(root.capabilityCommitment), true);
    } finally {
      if (state?.db?.open) state.close();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("hardhat");
const snarkjs = require("snarkjs");
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
  buildCircuitInput,
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

describe("Deadline receipt: fresh proof and delayed settlement", function () {
  this.timeout(300_000);

  it("proves a receipt created at the child deadline and settles after root expiry", async function () {
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
    let gatewayTime = latest.timestamp;

    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "zk-crossagent-e2e-")
    );
    const databasePath = path.join(temporaryDirectory, "e2e.sqlite");
    const masterKey = crypto.randomBytes(32);
    let state = new PersistentProtocolState(databasePath, {
      clock: () => gatewayTime,
    });
    let gateway = new SecureGatewayV2({
      state,
      poseidon,
      eip712Domain: domain,
      settlementDomainHash: domainHash,
      providerSigner: provider,
      masterKey,
      clock: () => gatewayTime,
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
      gatewayTime = child.expiry;
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
      assert.strictEqual(committed.receipt.economics.createdAt, child.expiry);
      await ethers.provider.send("evm_setNextBlockTimestamp", [root.expiry + 1]);
      await ethers.provider.send("evm_mine", []);
      gatewayTime = root.expiry + 1;
      const released = await gateway.confirmAndRelease(
        reserved.callId,
        buyerSignature
      );
      assert.strictEqual(decryptDelivery(released).toString("utf8"), "benign");

      state.close();
      state = new PersistentProtocolState(databasePath, {
        clock: () => gatewayTime,
      });
      gateway = new SecureGatewayV2({
        state,
        poseidon,
        eip712Domain: domain,
        settlementDomainHash: domainHash,
        providerSigner: provider,
        masterKey,
        clock: () => gatewayTime,
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
      const circuit = buildCircuitInput(poseidon, [{ root, child, receipt: committed.receipt }], {
        settlementDomainHash: domainHash, batchEpoch: 1,
      });
      assert.strictEqual(circuit.expectedBatchRoot.toString(), tree.root.toString());
      const project = path.resolve(__dirname, "..");
      const proofDirectory = path.resolve(project, process.env.JNCA_PROOF_OUTPUT || "reproducibility/issue01-03-20261015/fresh-proof");
      if (!proofDirectory.startsWith(project + path.sep)) throw new Error("proof output must remain inside JNCA");
      fs.mkdirSync(proofDirectory, { recursive: true });
      fs.writeFileSync(path.join(proofDirectory, "input.json"), JSON.stringify(circuit.input, null, 2));
      const witnessPath = path.join(proofDirectory, "boundary.wtns");
      await snarkjs.wtns.calculate(circuit.input,
        path.join(project, "circuits/v2/build/zk_crossagent_v2_js/zk_crossagent_v2.wasm"),
        witnessPath, { singleThread: true });
      assert.strictEqual(await snarkjs.wtns.check(
        path.join(project, "circuits/v2/build/zk_crossagent_v2.r1cs"), witnessPath), true);
      const { proof, publicSignals } = await snarkjs.groth16.prove(
        path.join(project, "circuits/v2/setup/zk_crossagent_v2_final.zkey"), witnessPath);
      const verificationKey = JSON.parse(fs.readFileSync(
        path.join(project, "circuits/v2/evidence/verification_key.json"), "utf8"));
      assert.strictEqual(await snarkjs.groth16.verify(verificationKey, publicSignals, proof), true);
      assert.strictEqual(publicSignals[0], tree.root.toString());
      const calldata = JSON.parse("[" + await snarkjs.groth16.exportSolidityCallData(proof, publicSignals) + "]");
      const Verifier = await ethers.getContractFactory("ZkCrossAgentBatchVerifierV2");
      const verifier = await Verifier.deploy();
      await verifier.deployed();
      assert.strictEqual(await verifier.verifyProof(...calldata), true);
      fs.writeFileSync(path.join(proofDirectory, "proof.json"), JSON.stringify(proof, null, 2));
      fs.writeFileSync(path.join(proofDirectory, "public.json"), JSON.stringify(publicSignals, null, 2));
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
      const finalBlock = await ethers.provider.getBlock("latest");
      assert(finalBlock.timestamp > root.expiry);
      fs.writeFileSync(path.join(proofDirectory, "result.json"), JSON.stringify({
        environment: "local Hardhat network; authorized endpoint relay",
        freshGroth16Proof: true, offchainVerified: true, onchainVerified: true,
        receiptCreatedAt: committed.receipt.economics.createdAt,
        childExpiry: child.expiry, rootExpiry: root.expiry,
        settlementBlockTimestamp: finalBlock.timestamp,
        callState: state.getCall(reserved.callId).state,
        settledAmount: durableRoot.settledAmount.toString(),
        reservedAmount: durableRoot.reservedAmount.toString(),
      }, null, 2) + "\n");
    } finally {
      if (state?.db?.open) state.close();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});


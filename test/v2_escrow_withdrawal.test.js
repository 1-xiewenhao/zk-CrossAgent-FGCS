const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PersistentProtocolState } = require("../lib/v2/persistent-state");
const { ROOT_BUDGET_RELEASE_TYPES, authorizeRootBudgetRelease } = require("../lib/v2/escrow-withdrawal");
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

describe("Escrow withdrawal and reconciled root-budget release", function () {
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

  let rootNonce;
  before(async function () { poseidon = await buildPoseidon(); });
  beforeEach(async function () {
    rootNonce = 0;
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

  async function registerRoot({ budget = 100, maxSubcalls = 4, nonce = ++rootNonce } = {}) {
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
      nonce,
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


  async function expire(root) {
    const latest = await ethers.provider.getBlock("latest");
    await ethers.provider.send("evm_setNextBlockTimestamp", [Math.max(Number(root.expiry), latest.timestamp) + 1]);
    await ethers.provider.send("evm_mine", []);
  }
  async function releaseAuthorization(root, overrides = {}, signer = deployer, signingDomain = domain) {
    const record = await escrow.getRootRecord(root.capabilityCommitment);
    const statement = {
      protocolVersion: 2, rootCommitment: root.capabilityCommitment, payer: root.payer,
      settledAmount: record.settledAmount.toString(), settledCalls: Number(record.settledCalls),
      validUntil: Number(root.expiry) + 1000, settlementDomainHash: domainHash, ...overrides,
    };
    return { statement, signature: await signer._signTypedData(signingDomain, ROOT_BUDGET_RELEASE_TYPES, statement) };
  }
  function release(auth) {
    const a = auth.statement;
    return escrow.releaseUnusedRootBudget(a.rootCommitment, a.settledAmount, a.settledCalls, a.validUntil, auth.signature);
  }
  async function assertBalances(balance, protectedAmount, free) {
    assert.strictEqual((await escrow.escrowBalance(payer.address)).toString(), String(balance));
    assert.strictEqual((await escrow.protectedBudget(payer.address)).toString(), String(protectedAmount));
    assert.strictEqual((await escrow.withdrawableBalance(payer.address)).toString(), String(free));
  }
  function gatewayState(root, databasePath = ":memory:") {
    const state = new PersistentProtocolState(databasePath, { clock: () => Number(root.expiry) - 100 });
    state.registerRoot({ rootCommitment: root.capabilityCommitment, payer: root.payer, buyer: root.buyer,
      budget: root.budget, maxSubcalls: root.maxSubcalls, expiry: root.expiry, metadata: { root } });
    state.clock = () => Number(root.expiry) + 1;
    return state;
  }
  function authorize(state, root, extra = {}) {
    return authorizeRootBudgetRelease({ state, escrow, signer: deployer, rootCommitment: root.capabilityCommitment,
      confirmations: 1, clock: () => Number(root.expiry) + 1, ...extra });
  }

  it("returns an unallocated deposit only to the payer's chosen recipient", async function () {
    await escrow.connect(payer).depositFor(payer.address, { value: 100 });
    await expectRevert(escrow.connect(attacker).withdraw(1, attacker.address), "protected funds");
    const before = await ethers.provider.getBalance(buyer.address);
    const tx = await escrow.connect(payer).withdraw(40, buyer.address);
    const result = await tx.wait();
    assert(result.events.some((event) => event.event === "Withdrawn"));
    assert.strictEqual((await ethers.provider.getBalance(buyer.address)).sub(before).toString(), "40");
    await assertBalances(60, 0, 60);
  });

  it("rejects zero amounts, invalid recipients, and over-withdrawal", async function () {
    await escrow.connect(payer).depositFor(payer.address, { value: 10 });
    await expectRevert(escrow.connect(payer).withdraw(0, payer.address), "zero withdrawal");
    await expectRevert(escrow.connect(payer).withdraw(1, ethers.constants.AddressZero), "invalid recipient");
    await expectRevert(escrow.connect(payer).withdraw(1, escrow.address), "invalid recipient");
    await expectRevert(escrow.connect(payer).withdraw(11, payer.address), "protected funds");
    await assertBalances(10, 0, 10);
  });

  it("protects every registered root, even before receipts are submitted", async function () {
    await registerRoot({ budget: 60 });
    await registerRoot({ budget: 30 });
    await escrow.connect(payer).depositFor(payer.address, { value: 100 });
    await assertBalances(100, 90, 10);
    await expectRevert(escrow.connect(payer).withdraw(11, payer.address), "protected funds");
    await escrow.connect(payer).withdraw(10, buyer.address);
    await assertBalances(90, 90, 0);
  });

  it("reports zero withdrawable funds for an underfunded root without arithmetic underflow", async function () {
    await registerRoot();
    await escrow.connect(payer).depositFor(payer.address, { value: 20 });
    await assertBalances(20, 100, 0);
    await expectRevert(escrow.connect(payer).withdraw(1, payer.address), "protected funds");
  });

  it("retains collateral for a timely receipt settling after expiry", async function () {
    const root = await registerRoot();
    await escrow.connect(payer).depositFor(payer.address, { value: 120 });
    const item = await createSignedReceipt(root, "21");
    const batch = await acceptBatch([item]);
    await expire(root);
    await escrow.connect(payer).withdraw(20, payer.address);
    await expectRevert(escrow.connect(payer).withdraw(1, payer.address), "protected funds");
    await settle(item, batch);
    await assertBalances(90, 90, 0);
    assert.strictEqual(await escrow.isSettled(item.receipt.identity.callId), true);
  });

  it("requires expiry and gateway authority before releasing unused root funds", async function () {
    const root = await registerRoot();
    await escrow.connect(payer).depositFor(payer.address, { value: 100 });
    const valid = await releaseAuthorization(root);
    await expectRevert(release(valid), "root still active");
    await expire(root);
    const forged = await releaseAuthorization(root, {}, payer);
    await expectRevert(release(forged), "invalid release authority");
    await release(valid);
    await assertBalances(100, 0, 100);
    await escrow.connect(payer).withdraw(100, payer.address);
    await assertBalances(0, 0, 0);
  });

  it("binds release signatures to chain, contract, settlement domain, and root", async function () {
    const root = await registerRoot();
    const other = await registerRoot();
    await expire(root);
    for (const signingDomain of [{ ...domain, chainId: chainId + 1 }, { ...domain, verifyingContract: attacker.address }]) {
      await expectRevert(release(await releaseAuthorization(root, {}, deployer, signingDomain)), "invalid release authority");
    }
    await expectRevert(release(await releaseAuthorization(root, { settlementDomainHash: ethers.constants.HashZero })), "invalid release authority");
    const auth = await releaseAuthorization(root);
    auth.statement.rootCommitment = other.capabilityCommitment;
    await expire(other);
    await expectRevert(release(auth), "invalid release authority");
  });

  it("rejects expired authorizations and repeated root releases", async function () {
    const root = await registerRoot();
    await expire(root);
    await expectRevert(release(await releaseAuthorization(root, { validUntil: root.expiry })), "release authorization expired");
    const auth = await releaseAuthorization(root);
    await release(auth);
    await expectRevert(release(auth), "root funds already released");
    await assertBalances(0, 0, 0);
  });

  it("rejects a release whose settlement counters changed after authorization", async function () {
    const root = await registerRoot();
    await escrow.connect(payer).depositFor(payer.address, { value: 100 });
    const item = await createSignedReceipt(root, "22");
    const batch = await acceptBatch([item]);
    const stale = await releaseAuthorization(root);
    await expire(root);
    await settle(item, batch);
    await expectRevert(release(stale), "settlement snapshot changed");
    await assertBalances(90, 90, 0);
  });

  it("prevents a released root from consuming another root's protected funds", async function () {
    const root = await registerRoot({ budget: 60 });
    await registerRoot({ budget: 40 });
    await escrow.connect(payer).depositFor(payer.address, { value: 100 });
    const item = await createSignedReceipt(root, "23");
    const batch = await acceptBatch([item]);
    await expire(root);
    // Deliberately bypass the honest gateway to exercise the contract's terminal guard.
    await release(await releaseAuthorization(root));
    await escrow.connect(payer).withdraw(60, payer.address);
    await expectRevert(settle(item, batch), "root funds released");
    await assertBalances(40, 40, 0);
  });

  it("rolls back accounting when the recipient rejects payment", async function () {
    const Receiver = await ethers.getContractFactory("WithdrawalReceiverV2");
    const receiver = await Receiver.deploy(); await receiver.deployed();
    await receiver.configure(escrow.address, true, false);
    await escrow.connect(payer).depositFor(payer.address, { value: 10 });
    await expectRevert(escrow.connect(payer).withdraw(10, receiver.address), "withdrawal failed");
    await assertBalances(10, 0, 10);
  });

  it("blocks callback reentrancy without losing the remaining deposit", async function () {
    const Receiver = await ethers.getContractFactory("WithdrawalReceiverV2");
    const receiver = await Receiver.deploy(); await receiver.deployed();
    await receiver.configure(escrow.address, false, true);
    await escrow.connect(payer).depositFor(receiver.address, { value: 10 });
    await receiver.take(6);
    assert.strictEqual(await receiver.reentrySucceeded(), false);
    assert.strictEqual((await escrow.escrowBalance(receiver.address)).toString(), "4");
    assert.strictEqual((await ethers.provider.getBalance(receiver.address)).toString(), "6");
  });

  it("recovers the entire unused expired root via finalized gateway reconciliation", async function () {
    const root = await registerRoot();
    await escrow.connect(payer).depositFor(payer.address, { value: 100 });
    const state = gatewayState(root);
    try {
      await expire(root);
      const auth = await authorize(state, root);
      assert(state.getRootBudgetRelease(root.capabilityCommitment).authorization.signature);
      await release(auth);
      await escrow.connect(payer).withdraw(100, buyer.address);
      await assertBalances(0, 0, 0);
    } finally { state.close(); }
  });

  it("recovers only the unspent balance after an actually settled service call", async function () {
    const root = await registerRoot();
    await escrow.connect(payer).depositFor(payer.address, { value: 100 });
    const item = await createSignedReceipt(root, "24");
    const batch = await acceptBatch([item]);
    const state = gatewayState(root);
    try {
      state.clock = () => root.expiry - 100;
      const call = state.reserveCall({ callId: item.receipt.identity.callId, rootCommitment: root.capabilityCommitment,
        childIssuer: root.issuer, childNonce: 124, amount: 10 });
      state.recordProviderCommitment(call.callId, {}, item.providerSignature);
      state.recordBuyerConfirmation(call.callId, item.buyerSignature);
      state.recordKeyRelease(call.callId, item.keyReveal, ethers.utils.keccak256(item.keyReveal));
      state.sealBatch({ epoch: 1, batchRoot: batch.tree.root, callIds: [call.callId] });
      state.markProved(call.callId); state.markRootRelayed(call.callId);
      const tx = await settle(item, batch); await tx.wait();
      state.markSettling(call.callId, tx.hash); state.markSettled(call.callId);
      await expire(root); state.clock = () => root.expiry + 1;
      const auth = await authorize(state, root); await release(auth);
      await escrow.connect(payer).withdraw(90, buyer.address);
      await assertBalances(0, 0, 0);
      assert.strictEqual((await escrow.getRootRecord(root.capabilityCommitment)).settledAmount.toString(), "10");
    } finally { state.close(); }
  });

  for (const phase of ["RESERVED", "BUYER_CONFIRMED", "KEY_RELEASED", "SETTLING"]) {
    it("refuses gateway release with an outstanding " + phase + " call", async function () {
      const root = await registerRoot();
      const state = gatewayState(root);
      try {
        state.clock = () => root.expiry - 100;
        const call = state.reserveCall({ callId: ethers.utils.id(phase), rootCommitment: root.capabilityCommitment,
          childIssuer: root.issuer, childNonce: 55, amount: 10 });
        if (phase !== "RESERVED") {
          state.recordProviderCommitment(call.callId, {}, "0x1234");
          state.recordBuyerConfirmation(call.callId, "0x1234");
        }
        if (["KEY_RELEASED", "SETTLING"].includes(phase)) state.recordKeyRelease(call.callId, ethers.utils.id("key"), ethers.utils.id("hash"));
        if (phase === "SETTLING") {
          state.sealBatch({ epoch: 1, batchRoot: 1, callIds: [call.callId] });
          state.markProved(call.callId); state.markRootRelayed(call.callId);
          state.markSettling(call.callId, ethers.utils.id("tx"));
        }
        await expire(root); state.clock = () => root.expiry + 1;
        await assert.rejects(authorize(state, root), /outstanding obligations/);
        assert.strictEqual(state.getRoot(root.capabilityCommitment).reservedAmount, 10n);
        assert.strictEqual(state.getRootBudgetRelease(root.capabilityCommitment), null);
      } finally { state.close(); }
    });
  }

  it("rejects a gateway/on-chain settlement mismatch", async function () {
    const root = await registerRoot();
    const state = gatewayState(root);
    try {
      state.db.prepare("UPDATE roots SET settled_amount = '1' WHERE root_commitment = ?").run(root.capabilityCommitment);
      await expire(root);
      await assert.rejects(authorize(state, root), /snapshot disagrees/);
    } finally { state.close(); }
  });

  it("requires a finalized expired root and the designated signer", async function () {
    const root = await registerRoot();
    const state = gatewayState(root);
    try {
      await assert.rejects(authorize(state, root), /expiry is not finalized/);
      await expire(root);
      await assert.rejects(authorize(state, root, { confirmations: 0 }), /positive finality/);
      await assert.rejects(authorize(state, root, { confirmations: 2 }), /expiry is not finalized/);
      await assert.rejects(authorize(state, root, { signer: payer }), /configured release authority/);
    } finally { state.close(); }
  });

  it("persists the admission fence and authorization across restart", async function () {
    const root = await registerRoot();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "zk-withdrawal-"));
    const dbPath = path.join(temp, "state.sqlite");
    let state = gatewayState(root, dbPath);
    try {
      await expire(root); const first = await authorize(state, root);
      state.close();
      state = new PersistentProtocolState(dbPath, { clock: () => root.expiry - 100 });
      assert.strictEqual(state.getRootBudgetRelease(root.capabilityCommitment).authorization.signature, first.signature);
      assert.throws(() => state.reserveCall({ callId: ethers.utils.id("new-after-release"), rootCommitment: root.capabilityCommitment,
        childIssuer: root.issuer, childNonce: 777, amount: 1 }), /root is not open/);
      state.clock = () => root.expiry + 1;
      const retry = await authorize(state, root);
      await release(retry);
      await assert.rejects(authorize(state, root), /already released/);
    } finally { if (state.db.open) state.close(); fs.rmSync(temp, { recursive: true, force: true }); }
  });
});

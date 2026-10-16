const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const { buildPoseidon } = require("circomlibjs");
const {
  PROTOCOL_VERSION,
  ROOT_CAPABILITY_TYPES,
  CHILD_CAPABILITY_TYPES,
  CALLER_CONFIRMATION_TYPES,
  RECEIPT_TYPES,
  computeReceiptCommitment,
  eip712Domain,
  rootCapabilityTypedValue,
  childCapabilityTypedValue,
  settlementDomainHash,
  computeRootCapabilityCommitment,
  computeChildCapabilityCommitment,
  callerConfirmation,
} = require("../lib/protocol-v2");
const {
  PersistentProtocolState,
} = require("../lib/v2/persistent-state");
const {
  SecureGatewayV2,
  decryptDelivery,
} = require("../lib/v2/secure-gateway");

function hash(label) {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(label));
}

describe("Issues 1-3: authorization and receipt boundaries", function () {
  this.timeout(120_000);

  let temporaryDirectory;
  let databasePath;
  let state;
  let gateway;
  let poseidon;
  let payer;
  let buyer;
  let provider;
  let orchestrator;
  let attacker;
  let masterKey;
  let domain;
  let domainHash;
  let root;
  let child;
  let timestamp;

  before(async function () { poseidon = await buildPoseidon(); });

  beforeEach(async function () {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "zk-crossagent-gateway-")
    );
    databasePath = path.join(temporaryDirectory, "gateway-v2.sqlite");
    timestamp = 1_900_000_000;
    payer = ethers.Wallet.createRandom();
    buyer = ethers.Wallet.createRandom();
    provider = ethers.Wallet.createRandom();
    orchestrator = ethers.Wallet.createRandom();
    attacker = ethers.Wallet.createRandom();
    masterKey = crypto.randomBytes(32);
    domain = eip712Domain(
      11155111,
      "0x5000000000000000000000000000000000000005"
    );
    domainHash = settlementDomainHash({
      serviceChainId: 80002,
      serviceRegistry: "0x6000000000000000000000000000000000000006",
      settlementChainId: 11155111,
      settlementContract: domain.verifyingContract,
    });
    state = new PersistentProtocolState(databasePath, {
      clock: () => timestamp,
    });
    gateway = new SecureGatewayV2({
      state,
      poseidon,
      eip712Domain: domain,
      settlementDomainHash: domainHash,
      providerSigner: provider,
      masterKey,
      clock: () => timestamp,
    });

    root = {
      protocolVersion: PROTOCOL_VERSION,
      issuer: payer.address,
      payer: payer.address,
      buyer: buyer.address,
      taskId: hash("secure-task"),
      permissions: 7,
      budget: 100,
      expiry: timestamp + 3600,
      maxSubcalls: 4,
      nonce: 1,
      scopeHash: hash("secure-scope"),
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

    child = {
      protocolVersion: PROTOCOL_VERSION,
      issuer: root.issuer,
      buyer: root.buyer,
      provider: provider.address,
      parentCommitment: root.capabilityCommitment,
      taskId: root.taskId,
      permissions: 3,
      budget: 20,
      expiry: root.expiry - 60,
      maxSubcalls: 1,
      nonce: 100,
      scopeHash: root.scopeHash,
      settlementDomainHash: domainHash,
      capabilityCommitment: "0",
    };
    child.capabilityCommitment = computeChildCapabilityCommitment(
      poseidon,
      child
    ).toString();
  });

  afterEach(function () {
    if (state?.db?.open) state.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  async function reserve(overrides = {}) {
    const selectedChild = { ...child, ...overrides };
    selectedChild.capabilityCommitment = computeChildCapabilityCommitment(
      poseidon,
      selectedChild
    ).toString();
    const childSignature = await buyer._signTypedData(
      domain,
      CHILD_CAPABILITY_TYPES,
      childCapabilityTypedValue(selectedChild)
    );
    return gateway.reserveAuthorizedCall({
      root,
      child: selectedChild,
      childSignature,
      request: { method: "summarize", text: "JNCA evidence" },
      providerAmount: 8,
      orchestratorFee: 2,
      orchestrator: orchestrator.address,
    });
  }

  async function buyerSignatureFor(committed, signer = buyer, selectedDomain = domain) {
    return signer._signTypedData(
      selectedDomain,
      CALLER_CONFIRMATION_TYPES,
      callerConfirmation(
        committed.receipt,
        committed.providerSignature
      )
    );
  }


  function assertAccounting(reservedAmount, reservedCalls) {
    const stored = state.getRoot(root.capabilityCommitment);
    assert.strictEqual(stored.reservedAmount, BigInt(reservedAmount));
    assert.strictEqual(stored.reservedCalls, reservedCalls);
    assert.strictEqual(stored.settledAmount, 0n);
    assert.strictEqual(state.assertRootInvariant(root.capabilityCommitment), true);
  }

  function assertNoAdmission() {
    assertAccounting(0, 0);
    for (const table of ["calls", "consumed_child_nonces", "call_transitions"]) {
      assert.strictEqual(state.db.prepare("SELECT COUNT(*) AS n FROM " + table).get().n, 0);
    }
  }

  it("rejects a signed zero-count child before nonce or budget consumption", async function () {
    await assert.rejects(reserve({ maxSubcalls: 0 }), /child call limit must be positive/);
    assertNoAdmission();
    assert.strictEqual((await reserve()).state, "RESERVED");
  });

  it("still rejects a child count above the root bound", async function () {
    await assert.rejects(reserve({ maxSubcalls: root.maxSubcalls + 1 }), /exceeds root limits/);
    assertNoAdmission();
  });

  for (const count of [1, 4]) {
    it("accepts child count " + count + " but consumes its nonce only once", async function () {
      const first = await reserve({ maxSubcalls: count });
      const retry = await reserve({ maxSubcalls: count });
      assert.strictEqual(first.idempotent, false);
      assert.strictEqual(retry.idempotent, true);
      assertAccounting(10, 1);
      await assert.rejects(reserve({ maxSubcalls: count, budget: 19 }), /nonce already consumed/);
      assertAccounting(10, 1);
    });
  }

  for (const offset of [-1, 0]) {
    it("rejects child expiry at admission time " + offset + " with a live root", async function () {
      await assert.rejects(reserve({ expiry: timestamp + offset }), /child is expired/);
      assertNoAdmission();
      assert.strictEqual((await reserve()).state, "RESERVED");
    });
  }

  it("accepts a new call one second before child expiry", async function () {
    const call = await reserve({ expiry: timestamp + 1 });
    assert.strictEqual(call.state, "RESERVED");
    assertAccounting(10, 1);
  });

  it("checks expiry inside the reservation transaction after acquiring the write lock", async function () {
    const transaction = state.db.transaction.bind(state.db);
    state.db.transaction = (fn) => transaction((...args) => {
      timestamp = child.expiry;
      return fn(...args);
    });
    await assert.rejects(reserve(), /child is expired/);
    assertNoAdmission();
  });

  it("keeps an existing reservation idempotent after expiry without admitting another call", async function () {
    const first = await reserve();
    timestamp = root.expiry + 1;
    const retry = await reserve();
    assert.strictEqual(retry.callId, first.callId);
    assert.strictEqual(retry.idempotent, true);
    assertAccounting(10, 1);
    await assert.rejects(reserve({ nonce: 101 }), /root is expired/);
    assertAccounting(10, 1);
  });

  for (const offset of [-1, 0]) {
    it("accepts a receipt at child expiry " + offset + " and releases it after root expiry", async function () {
      const call = await reserve();
      timestamp = child.expiry + offset;
      const committed = await gateway.commitEncryptedResponse(call.callId, "on-time response");
      assert.strictEqual(committed.receipt.economics.createdAt, timestamp);
      timestamp = root.expiry + 1;
      const released = await gateway.confirmAndRelease(call.callId, await buyerSignatureFor(committed));
      assert.strictEqual(decryptDelivery(released).toString(), "on-time response");
      assert.strictEqual(state.getCall(call.callId).state, "KEY_RELEASED");
      assertAccounting(10, 1);
    });
  }

  for (const deadline of ["child", "root"]) {
    it("rejects a response after " + deadline + " expiry and durably releases its reservation", async function () {
      const call = await reserve();
      timestamp = (deadline === "child" ? child.expiry : root.expiry) + 1;
      await assert.rejects(gateway.commitEncryptedResponse(call.callId, "late response"), /receipt timestamp exceeds capability expiry/);
      const stored = state.getCall(call.callId);
      assert.strictEqual(stored.state, "EXPIRED");
      assert.strictEqual(stored.providerPayload, null);
      assert.strictEqual(stored.buyerSignature, null);
      assert.strictEqual(stored.keyReveal, null);
      assertAccounting(0, 0);
      assert.strictEqual(state.db.prepare("SELECT COUNT(*) AS n FROM consumed_child_nonces").get().n, 1);
      await assert.rejects(gateway.commitEncryptedResponse(call.callId, "retry"), /must be RESERVED/);
      await assert.rejects(gateway.confirmAndRelease(call.callId, "0x00"), /must be RESPONSE_COMMITTED/);
      assert.strictEqual(state.transitions(call.callId).filter((t) => t.to_state === "EXPIRED").length, 1);
      if (deadline === "child") {
        await assert.rejects(reserve({ expiry: root.expiry }), /nonce already consumed/);
        assert.strictEqual((await reserve({ expiry: root.expiry, nonce: 101 })).state, "RESERVED");
        assertAccounting(10, 1);
      }
    });
  }

  // Construct a validly signed old-version database record whose timestamp is late.
  async function legacyLateReceipt(targetState) {
    const call = await reserve();
    const committed = await gateway.commitEncryptedResponse(call.callId, "legacy response");
    const payload = state.getCall(call.callId).providerPayload;
    payload.receipt.economics.createdAt = child.expiry + 1;
    payload.receipt.receiptCommitment = computeReceiptCommitment(poseidon, payload.receipt).toString();
    const signature = await provider._signTypedData(domain, RECEIPT_TYPES, payload.receipt);
    state.db.prepare("UPDATE calls SET provider_payload_json = ?, provider_signature = ? WHERE call_id = ?")
      .run(JSON.stringify(payload), signature, call.callId);
    const buyerSignature = await buyerSignatureFor({ receipt: payload.receipt, providerSignature: signature });
    if (targetState === "BUYER_CONFIRMED") state.recordBuyerConfirmation(call.callId, buyerSignature);
    return { callId: call.callId, buyerSignature };
  }

  it("rejects an old late receipt before buyer confirmation", async function () {
    const call = await legacyLateReceipt("RESPONSE_COMMITTED");
    await assert.rejects(gateway.confirmAndRelease(call.callId, call.buyerSignature), /receipt timestamp exceeds capability expiry/);
    assert.strictEqual(state.getCall(call.callId).state, "EXPIRED");
    assert.strictEqual(state.getCall(call.callId).buyerSignature, null);
    assert.strictEqual(state.getCall(call.callId).keyReveal, null);
    assertAccounting(0, 0);
  });

  it("rejects an old late receipt during recovery before revealing its key", async function () {
    const call = await legacyLateReceipt("BUYER_CONFIRMED");
    state.close();
    state = new PersistentProtocolState(databasePath, { clock: () => timestamp });
    gateway = new SecureGatewayV2({ state, poseidon, eip712Domain: domain,
      settlementDomainHash: domainHash, providerSigner: provider, masterKey, clock: () => timestamp });
    assert.throws(() => gateway.releaseConfirmedKey(call.callId), /receipt timestamp exceeds capability expiry/);
    assert.strictEqual(state.getCall(call.callId).state, "FAILED_PERMANENT");
    assert.strictEqual(state.getCall(call.callId).keyReveal, null);
    assertAccounting(0, 0);
    assert.throws(() => gateway.releaseConfirmedKey(call.callId), /must be BUYER_CONFIRMED/);
    assertAccounting(0, 0);
  });
});

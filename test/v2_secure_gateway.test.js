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

describe("SecureGatewayV2", function () {
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

  beforeEach(async function () {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "zk-crossagent-gateway-")
    );
    databasePath = path.join(temporaryDirectory, "gateway-v2.sqlite");
    timestamp = 1_900_000_000;
    poseidon = await buildPoseidon();
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

  it("delivers ciphertext before confirmation and the key only afterward", async function () {
    const call = await reserve();
    const committed = await gateway.commitEncryptedResponse(
      call.callId,
      "confidential service response"
    );
    assert.strictEqual(
      JSON.stringify(committed).includes("confidential service response"),
      false
    );
    assert.strictEqual(Object.hasOwn(committed, "keyReveal"), false);
    assert.strictEqual(
      state.getCall(call.callId).state,
      "RESPONSE_COMMITTED"
    );

    const buyerSignature = await buyerSignatureFor(committed);
    const released = await gateway.confirmAndRelease(
      call.callId,
      buyerSignature
    );
    assert.strictEqual(state.getCall(call.callId).state, "KEY_RELEASED");
    assert.strictEqual(
      decryptDelivery(released).toString("utf8"),
      "confidential service response"
    );
  });

  it("recovers a sealed provider key after gateway restart", async function () {
    const call = await reserve();
    const committed = await gateway.commitEncryptedResponse(
      call.callId,
      "restart-safe response"
    );
    const buyerSignature = await buyerSignatureFor(committed);
    state.close();

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
    const released = await gateway.confirmAndRelease(
      call.callId,
      buyerSignature
    );
    assert.strictEqual(
      decryptDelivery(released).toString("utf8"),
      "restart-safe response"
    );
    assert.strictEqual(state.getCall(call.callId).keyReveal, released.keyReveal);
  });

  it("rejects buyer forgery and cross-domain replay before confirmation", async function () {
    const call = await reserve();
    const committed = await gateway.commitEncryptedResponse(
      call.callId,
      "signed response"
    );
    const forged = await buyerSignatureFor(committed, attacker);
    await assert.rejects(
      gateway.confirmAndRelease(call.callId, forged),
      /invalid buyer confirmation signature/
    );
    assert.strictEqual(
      state.getCall(call.callId).state,
      "RESPONSE_COMMITTED"
    );

    const wrongDomain = {
      ...domain,
      verifyingContract: attacker.address,
    };
    const replay = await buyerSignatureFor(
      committed,
      buyer,
      wrongDomain
    );
    await assert.rejects(
      gateway.confirmAndRelease(call.callId, replay),
      /invalid buyer confirmation signature/
    );
  });

  it("rejects capability escalation before consuming the child nonce", async function () {
    await assert.rejects(
      reserve({ permissions: 8 }),
      /child permissions exceed root permissions/
    );
    const valid = await reserve();
    assert.strictEqual(valid.state, "RESERVED");
  });

  it("rejects a forged child commitment and provider substitution", async function () {
    const forgedCommitmentChild = {
      ...child,
      capabilityCommitment: (
        BigInt(child.capabilityCommitment) + 1n
      ).toString(),
    };
    const forgedCommitmentSignature = await buyer._signTypedData(
      domain,
      CHILD_CAPABILITY_TYPES,
      childCapabilityTypedValue(forgedCommitmentChild)
    );
    assert.throws(
      () =>
        gateway.reserveAuthorizedCall({
          root,
          child: forgedCommitmentChild,
          childSignature: forgedCommitmentSignature,
          request: { method: "summarize", text: "forged" },
          providerAmount: 8,
          orchestratorFee: 2,
          orchestrator: orchestrator.address,
        }),
      /child capability commitment mismatch/
    );

    const substitutedProvider = {
      ...child,
      provider: attacker.address,
      nonce: 101,
    };
    substitutedProvider.capabilityCommitment =
      computeChildCapabilityCommitment(
        poseidon,
        substitutedProvider
      ).toString();
    const substitutedSignature = await buyer._signTypedData(
      domain,
      CHILD_CAPABILITY_TYPES,
      childCapabilityTypedValue(substitutedProvider)
    );
    assert.throws(
      () =>
        gateway.reserveAuthorizedCall({
          root,
          child: substitutedProvider,
          childSignature: substitutedSignature,
          request: { method: "summarize", text: "substituted" },
          providerAmount: 8,
          orchestratorFee: 2,
          orchestrator: orchestrator.address,
        }),
      /child provider does not identify this gateway/
    );
  });

  it("detects ciphertext tampering after a valid key release", async function () {
    const call = await reserve();
    const committed = await gateway.commitEncryptedResponse(
      call.callId,
      "tamper-evident response"
    );
    const released = await gateway.confirmAndRelease(
      call.callId,
      await buyerSignatureFor(committed)
    );
    const tampered = {
      ...released,
      envelope: {
        ...released.envelope,
        ciphertext: ethers.utils.hexlify(
          Buffer.concat([
            Buffer.from(ethers.utils.arrayify(released.envelope.ciphertext)),
            Buffer.from([1]),
          ])
        ),
      },
    };
    assert.throws(
      () => decryptDelivery(tampered),
      /ciphertext does not match receipt commitment/
    );
  });
});

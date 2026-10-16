const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const { buildPoseidon } = require("circomlibjs");
const {
  PROTOCOL_VERSION,
  RECEIPT_TYPES,
  computeReceiptCommitment,
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

const { verifyCommittedDelivery } = require("../lib/v2/delivery-validation");

function hash(label) {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(label));
}

describe("Buyer delivery validation", function () {
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


  function verify(committed, overrides = {}) {
    return verifyCommittedDelivery({ ...committed, poseidon, domain, root, child,
      request: { method: "summarize", text: "JNCA evidence" },
      providerAmount: 8, orchestratorFee: 2, orchestrator: orchestrator.address,
      ...overrides });
  }
  async function delivery() {
    const call = await reserve();
    return gateway.commitEncryptedResponse(call.callId, "confidential response");
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function flip(value) {
    const b = Buffer.from(ethers.utils.arrayify(value)); b[0] ^= 1;
    return ethers.utils.hexlify(b);
  }
  async function resign(c) {
    c.receipt.receiptCommitment = computeReceiptCommitment(poseidon, c.receipt).toString();
    c.providerSignature = await provider._signTypedData(domain, RECEIPT_TYPES, c.receipt);
    return c;
  }
  it("verifies a committed envelope without a key, then checks delivered bytes", async function () {
    const c = await delivery();
    assert.strictEqual(c.keyReveal, undefined);
    const confirmation = verify(c);
    const signature = await buyer._signTypedData(domain, CALLER_CONFIRMATION_TYPES, confirmation);
    const released = await gateway.confirmAndRelease(c.receipt.identity.callId, signature);
    assert.strictEqual(decryptDelivery(released).toString(), "confidential response");
    assert.deepStrictEqual(confirmation, callerConfirmation(c.receipt, c.providerSignature));
  });
  it("commits nonce, authentication tag, and ciphertext before confirmation", async function () {
    const c = await delivery();
    for (const field of ["nonce", "authTag", "ciphertext"]) {
      const bad = clone(c); bad.envelope[field] = flip(bad.envelope[field]);
      assert.throws(() => verify(bad), /ciphertext does not match/);
    }
  });
  it("binds all seven AAD fields to the signed receipt", async function () {
    const c = await delivery();
    for (const field of Object.keys(c.envelope.associatedData)) {
      const bad = clone(c);
      bad.envelope.associatedData[field] = field === "protocolVersion" ? 3 : hash("other");
      assert.throws(() => verify(bad), /associated data does not match/);
    }
    const extra = clone(c); extra.envelope.associatedData.unbound = "extra";
    assert.throws(() => verify(extra), /associated data does not match/);
  });
  it("uses canonical JSON independently of object insertion order", async function () {
    const c = await delivery();
    c.envelope.associatedData = Object.fromEntries(Object.entries(c.envelope.associatedData).reverse());
    assert.doesNotThrow(() => verify(c));
  });
  it("rejects unsupported algorithms and malformed nonce/tag lengths", async function () {
    const c = await delivery();
    const wrongAlgorithm = clone(c); wrongAlgorithm.envelope.algorithm = "AES-128-GCM";
    assert.throws(() => verify(wrongAlgorithm), /unsupported delivery algorithm/);
    for (const field of ["nonce", "authTag"]) {
      const bad = clone(c); bad.envelope[field] = "0x00";
      assert.throws(() => verify(bad), /invalid .* length/);
    }
  });
  it("rejects a forged provider signature before buyer signing", async function () {
    const c = await delivery();
    c.providerSignature = await attacker._signTypedData(domain, RECEIPT_TYPES, c.receipt);
    assert.throws(() => verify(c), /invalid provider receipt signature/);
  });
  it("rejects a stale receipt commitment even with a valid provider signature", async function () {
    const c = await delivery(); c.receipt.receiptCommitment = "1";
    c.providerSignature = await provider._signTypedData(domain, RECEIPT_TYPES, c.receipt);
    assert.throws(() => verify(c), /receipt commitment mismatch/);
  });
  it("checks request, payment, and identities against the buyer's retained context", async function () {
    const c = await delivery();
    for (const overrides of [{ request: { method: "other" } }, { providerAmount: 9 },
      { orchestratorFee: 3 }, { orchestrator: attacker.address },
      { child: { ...child, capabilityCommitment: "1" } }]) {
      assert.throws(() => verify(c, overrides), /receipt (request|payment|context) mismatch/);
    }
  });
  it("rejects signatures from a different chain or verifying contract", async function () {
    const c = await delivery();
    for (const wrong of [{ ...domain, chainId: domain.chainId + 1 },
      { ...domain, verifyingContract: attacker.address }]) {
      assert.throws(() => verify(c, { domain: wrong }), /invalid provider receipt signature/);
    }
  });
  it("checks the response hash only after key release and decryption", async function () {
    const c = await delivery();
    const signature = await buyerSignatureFor(c);
    const released = await gateway.confirmAndRelease(c.receipt.identity.callId, signature);
    const altered = clone(c); altered.receipt.delivery.responseHash = hash("false plaintext");
    await resign(altered);
    assert.doesNotThrow(() => verify(altered));
    assert.throws(() => decryptDelivery({ ...altered, keyReveal: released.keyReveal }), /plaintext does not match/);
  });
  it("requires the AES-GCM authentication tag to verify after key release", async function () {
    const c = await delivery();
    const released = await gateway.confirmAndRelease(c.receipt.identity.callId, await buyerSignatureFor(c));
    const altered = clone(c); altered.envelope.authTag = flip(altered.envelope.authTag);
    altered.receipt.delivery.ciphertextHash = ethers.utils.keccak256(ethers.utils.concat([
      altered.envelope.nonce, altered.envelope.authTag, altered.envelope.ciphertext]));
    await resign(altered);
    assert.doesNotThrow(() => verify(altered));
    assert.throws(() => decryptDelivery({ ...altered, keyReveal: released.keyReveal }), /authenticate|Unsupported state/);
  });
});

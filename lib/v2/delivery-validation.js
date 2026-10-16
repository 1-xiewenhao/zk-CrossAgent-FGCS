const { ethers } = require("ethers");
const { canonicalize } = require("json-canonicalize");
const {
  PROTOCOL_VERSION, RECEIPT_TYPES, computeCallId, computeReceiptCommitment,
  callerConfirmation,
} = require("../protocol-v2");

function sameHex(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }
function asBytes(value, name, length) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`${name} must be an even-length hexadecimal byte string`);
  }
  const out = Buffer.from(ethers.utils.arrayify(value));
  if (length !== undefined && out.length !== length) throw new Error(`invalid ${name} length`);
  return out;
}

// AAD is UTF-8 canonical JSON. It is not ABI encoding.
function receiptAssociatedData(receipt) {
  return {
    protocolVersion: Number(receipt.protocolVersion),
    callId: receipt.identity.callId,
    taskId: receipt.identity.taskId,
    requestHash: receipt.delivery.requestHash,
    provider: receipt.identity.provider,
    buyer: receipt.identity.buyer,
    settlementDomainHash: receipt.economics.settlementDomainHash,
  };
}

// This checks public commitments, without possession of the delivery key.
function validateDeliveryEnvelope(envelope, receipt) {
  if (Number(receipt.protocolVersion) !== PROTOCOL_VERSION) throw new Error("unsupported delivery version");
  if (!envelope || envelope.algorithm !== "AES-256-GCM") throw new Error("unsupported delivery algorithm");
  const nonce = asBytes(envelope.nonce, "nonce", 12);
  const authTag = asBytes(envelope.authTag, "authentication tag", 16);
  const ciphertext = asBytes(envelope.ciphertext, "ciphertext");
  const committedBytes = Buffer.concat([nonce, authTag, ciphertext]);
  if (!sameHex(ethers.utils.keccak256(committedBytes), receipt.delivery.ciphertextHash)) {
    throw new Error("ciphertext does not match receipt commitment");
  }
  if (canonicalize(envelope.associatedData) !== canonicalize(receiptAssociatedData(receipt))) {
    throw new Error("associated data does not match receipt context");
  }
  return { nonce, authTag, ciphertext };
}

// root, child, request, prices, and domain are the buyer's retained context,
// not context copied from a newly received receipt. No plaintext is checked here.
function verifyCommittedDelivery({
  envelope, receipt, providerSignature, poseidon, domain,
  root, child, request, providerAmount, orchestratorFee, orchestrator,
}) {
  if (!root || !child || request === undefined || !poseidon || !domain) {
    throw new Error("buyer context is required");
  }
  const identity = {
    callId: computeCallId({ settlementDomainHash: root.settlementDomainHash,
      taskId: root.taskId, childCapabilityCommitment: child.capabilityCommitment,
      childNonce: child.nonce }),
    taskId: root.taskId, rootCommitment: root.capabilityCommitment,
    childCommitment: child.capabilityCommitment, payer: root.payer,
    buyer: root.buyer, provider: child.provider, orchestrator,
  };
  for (const [key, expected] of Object.entries(identity)) {
    if (expected === undefined) throw new Error(`missing buyer context: ${key}`);
    const numeric = key === "rootCommitment" || key === "childCommitment";
    if (numeric ? BigInt(receipt.identity[key]) !== BigInt(expected)
      : !sameHex(receipt.identity[key], expected)) throw new Error(`receipt context mismatch: ${key}`);
  }
  const expectedRequestHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(canonicalize(request)));
  if (!sameHex(receipt.delivery.requestHash, expectedRequestHash)) throw new Error("receipt request mismatch");
  if (!sameHex(receipt.economics.settlementDomainHash, root.settlementDomainHash)) {
    throw new Error("receipt settlement domain mismatch");
  }
  if (providerAmount === undefined || orchestratorFee === undefined ||
      BigInt(receipt.economics.providerAmount) !== BigInt(providerAmount) ||
      BigInt(receipt.economics.orchestratorFee) !== BigInt(orchestratorFee)) {
    throw new Error("receipt payment mismatch");
  }
  const createdAt = BigInt(receipt.economics.createdAt);
  if (createdAt < 0n || createdAt > BigInt(child.expiry) || BigInt(child.expiry) > BigInt(root.expiry)) {
    throw new Error("receipt deadline mismatch");
  }
  validateDeliveryEnvelope(envelope, receipt);
  if (computeReceiptCommitment(poseidon, receipt) !== BigInt(receipt.receiptCommitment)) {
    throw new Error("receipt commitment mismatch");
  }
  const signer = ethers.utils.verifyTypedData(domain, RECEIPT_TYPES, receipt, providerSignature);
  if (!sameHex(signer, child.provider)) throw new Error("invalid provider receipt signature");
  return callerConfirmation(receipt, providerSignature);
}

module.exports = { receiptAssociatedData, validateDeliveryEnvelope, verifyCommittedDelivery };

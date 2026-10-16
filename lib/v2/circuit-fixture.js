const { ethers } = require("ethers");
const {
  PROTOCOL_VERSION,
  computeRootCapabilityCommitment,
  computeChildCapabilityCommitment,
  computeReceiptCommitment,
} = require("../protocol-v2");

const CIRCUIT_FIXTURE_DOMAIN_HASH = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("zk-crossagent-v2-witness-domain")
);

const CIRCUIT_FIXTURE_ADDRESSES = Object.freeze({
  payer: "0x1000000000000000000000000000000000000001",
  buyer: "0x2000000000000000000000000000000000000002",
  provider: "0x3000000000000000000000000000000000000003",
  orchestrator: "0x4000000000000000000000000000000000000004",
});

function fixtureHash(label) {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(label));
}

function createCircuitFixture(
  poseidon,
  {
    rootPermissions = 7,
    childPermissions = 3,
    rootBudget = 100,
    childBudget = 8,
    fixtureIndex = 0,
  } = {}
) {
  const suffix = fixtureIndex === 0 ? "" : `-${fixtureIndex}`;
  const root = {
    protocolVersion: PROTOCOL_VERSION,
    issuer: CIRCUIT_FIXTURE_ADDRESSES.payer,
    payer: CIRCUIT_FIXTURE_ADDRESSES.payer,
    buyer: CIRCUIT_FIXTURE_ADDRESSES.buyer,
    taskId: fixtureHash(`circuit-task${suffix}`),
    permissions: rootPermissions,
    budget: rootBudget,
    expiry: 2_000_000_000,
    maxSubcalls: 4,
    nonce: 11 + fixtureIndex * 2,
    scopeHash: fixtureHash(`circuit-scope${suffix}`),
    settlementDomainHash: CIRCUIT_FIXTURE_DOMAIN_HASH,
  };
  root.capabilityCommitment = computeRootCapabilityCommitment(
    poseidon,
    root
  ).toString();

  const child = {
    protocolVersion: PROTOCOL_VERSION,
    issuer: root.issuer,
    buyer: root.buyer,
    provider: CIRCUIT_FIXTURE_ADDRESSES.provider,
    parentCommitment: root.capabilityCommitment,
    taskId: root.taskId,
    permissions: childPermissions,
    budget: childBudget,
    expiry: root.expiry - 100,
    maxSubcalls: 1,
    nonce: 12 + fixtureIndex * 2,
    scopeHash: root.scopeHash,
    settlementDomainHash: CIRCUIT_FIXTURE_DOMAIN_HASH,
  };
  child.capabilityCommitment = computeChildCapabilityCommitment(
    poseidon,
    child
  ).toString();

  const receipt = {
    protocolVersion: PROTOCOL_VERSION,
    identity: {
      callId: fixtureHash(`circuit-call${suffix}`),
      taskId: root.taskId,
      rootCommitment: root.capabilityCommitment,
      childCommitment: child.capabilityCommitment,
      payer: root.payer,
      buyer: root.buyer,
      orchestrator: CIRCUIT_FIXTURE_ADDRESSES.orchestrator,
      provider: child.provider,
    },
    delivery: {
      requestHash: fixtureHash(`circuit-request${suffix}`),
      responseHash: fixtureHash(`circuit-response${suffix}`),
      ciphertextHash: fixtureHash(`circuit-ciphertext${suffix}`),
      keyCommitment: fixtureHash(`circuit-key${suffix}`),
    },
    economics: {
      providerAmount: 8,
      orchestratorFee: 2,
      createdAt: 1_900_000_000,
      settlementDomainHash: CIRCUIT_FIXTURE_DOMAIN_HASH,
    },
  };
  receipt.receiptCommitment = computeReceiptCommitment(
    poseidon,
    receipt
  ).toString();

  return { root, child, receipt };
}

module.exports = {
  CIRCUIT_FIXTURE_DOMAIN_HASH,
  createCircuitFixture,
};

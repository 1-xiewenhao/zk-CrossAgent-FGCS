const { ethers } = require("ethers");
const { PROTOCOL_VERSION, eip712Domain } = require("../protocol-v2");

const ROOT_BUDGET_RELEASE_TYPES = Object.freeze({
  RootBudgetReleaseV2: [
    { name: "protocolVersion", type: "uint16" },
    { name: "rootCommitment", type: "uint256" },
    { name: "payer", type: "address" },
    { name: "settledAmount", type: "uint64" },
    { name: "settledCalls", type: "uint32" },
    { name: "validUntil", type: "uint64" },
    { name: "settlementDomainHash", type: "bytes32" },
  ],
});

// The state is the authoritative gateway database, not a caller-supplied snapshot.
// Run this operator-side operation only with the gateway reconciliation signer.
async function authorizeRootBudgetRelease({
  state, escrow, signer, rootCommitment, confirmations,
  validitySeconds = 300, clock = () => Math.floor(Date.now() / 1000),
}) {
  if (!Number.isSafeInteger(confirmations) || confirmations < 1) {
    throw new Error("a positive finality confirmation depth is required");
  }
  if (!Number.isSafeInteger(validitySeconds) || validitySeconds < 1) {
    throw new Error("invalid authorization lifetime");
  }
  const provider = escrow.provider;
  if (!provider) throw new Error("settlement provider is required");
  const local = state.getRoot(rootCommitment);
  if (!local) throw new Error("unknown gateway root");
  const latest = await provider.getBlock("latest");
  const blockTag = latest.number - confirmations + 1;
  if (blockTag < 0) throw new Error("insufficient chain history for finality");
  const finalized = await provider.getBlock(blockTag);
  const chain = await escrow.getRootRecord(rootCommitment, { blockTag });
  if (!chain.exists) throw new Error("root is not registered in finalized state");
  if (finalized.timestamp < Number(chain.expiry)) {
    throw new Error("root expiry is not finalized");
  }
  const authority = await escrow.fundsReleaseAuthority();
  if (ethers.utils.getAddress(await signer.getAddress()) !== ethers.utils.getAddress(authority)) {
    throw new Error("signer is not the configured release authority");
  }
  if (await escrow.rootFundsReleased(rootCommitment)) throw new Error("root funds already released");
  const domainHash = await escrow.settlementDomainHash();
  if (local.metadata.root?.settlementDomainHash?.toLowerCase() !== domainHash.toLowerCase()) {
    throw new Error("gateway root settlement domain mismatch");
  }
  const snapshot = {
    payer: chain.payer, budget: chain.budget.toString(), expiry: chain.expiry.toString(),
    maxSubcalls: Number(chain.maxSubcalls), settledAmount: chain.settledAmount.toString(),
    settledCalls: Number(chain.settledCalls), blockNumber: finalized.number,
    blockHash: finalized.hash, settlementContract: escrow.address, settlementDomainHash: domainHash,
  };
  state.prepareRootBudgetRelease(rootCommitment, snapshot);
  const validUntil = Math.max(latest.timestamp, clock()) + validitySeconds;
  if (!Number.isSafeInteger(validUntil) || validUntil < 0) throw new Error("invalid expiry timestamp");
  const statement = {
    protocolVersion: PROTOCOL_VERSION, rootCommitment: String(rootCommitment),
    payer: chain.payer, settledAmount: snapshot.settledAmount,
    settledCalls: snapshot.settledCalls, validUntil, settlementDomainHash: domainHash,
  };
  const { chainId } = await provider.getNetwork();
  const domain = eip712Domain(chainId, escrow.address);
  const signature = await signer._signTypedData(domain, ROOT_BUDGET_RELEASE_TYPES, statement);
  const rechecked = await provider.getBlock(blockTag);
  if (!rechecked || rechecked.hash !== finalized.hash) {
    throw new Error("finalized settlement snapshot was reorganized");
  }
  return state.recordRootBudgetReleaseAuthorization(rootCommitment, {
    statement, signature, domain, snapshot,
  });
}

module.exports = { ROOT_BUDGET_RELEASE_TYPES, authorizeRootBudgetRelease };

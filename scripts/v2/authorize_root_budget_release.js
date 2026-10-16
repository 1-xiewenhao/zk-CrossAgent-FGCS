#!/usr/bin/env node
// Operator-side reconciliation only; this command never broadcasts a transaction.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { PersistentProtocolState } = require("../../lib/v2/persistent-state");
const { authorizeRootBudgetRelease } = require("../../lib/v2/escrow-withdrawal");
const PROJECT = fs.realpathSync(path.resolve(__dirname, "../.."));

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(name + " is not configured");
  return value;
}
function inside(candidate, label) {
  const resolved = path.resolve(PROJECT, candidate);
  const relative = path.relative(PROJECT, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(label + " must be inside JNCA");
  }
  return resolved;
}
async function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: node scripts/v2/authorize_root_budget_release.js <root-commitment> <output.json>\nRequired environment: GATEWAY_STATE_DB, SETTLEMENT_RPC_URL, ESCROW_ADDRESS, GATEWAY_RELEASE_PRIVATE_KEY, SETTLEMENT_FINALITY_CONFIRMATIONS\nOptional: RELEASE_VALIDITY_SECONDS (default 300). Uses the authoritative gateway state; signs only and sends no transaction.");
    return;
  }
  const [commitment, output] = process.argv.slice(2);
  if (!commitment || !output) throw new Error("root commitment and output path are required; see --help");
  const database = inside(required("GATEWAY_STATE_DB"), "database");
  if (!fs.existsSync(database)) throw new Error("authoritative gateway database does not exist");
  inside(fs.realpathSync(database), "database");
  const outputPath = inside(output, "output");
  // Require an existing output directory and reject symlink escapes.
  inside(path.join(fs.realpathSync(path.dirname(outputPath)), path.basename(outputPath)), "output");
  if (fs.existsSync(outputPath)) throw new Error("output already exists");
  const confirmations = Number(required("SETTLEMENT_FINALITY_CONFIRMATIONS"));
  const validitySeconds = Number(process.env.RELEASE_VALIDITY_SECONDS || 300);
  const provider = new ethers.providers.JsonRpcProvider(required("SETTLEMENT_RPC_URL"));
  const signer = new ethers.Wallet(required("GATEWAY_RELEASE_PRIVATE_KEY"), provider);
  const artifact = require("../../artifacts/contracts/v2/EscrowReceiptV2.sol/EscrowReceiptV2.json");
  const escrow = new ethers.Contract(ethers.utils.getAddress(required("ESCROW_ADDRESS")), artifact.abi, provider);
  const state = new PersistentProtocolState(database);
  try {
    const authorization = await authorizeRootBudgetRelease({
      state, escrow, signer, rootCommitment: BigInt(commitment).toString(),
      confirmations, validitySeconds,
    });
    fs.writeFileSync(outputPath, JSON.stringify(authorization, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log("Release authorization saved; no transaction was broadcast.");
  } finally { state.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });

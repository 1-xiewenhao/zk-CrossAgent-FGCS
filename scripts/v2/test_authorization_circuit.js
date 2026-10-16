const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const snarkjs = require("snarkjs");
const { buildPoseidon } = require("circomlibjs");
const { buildCircuitInput, computeRootCapabilityCommitment,
  computeChildCapabilityCommitment, computeReceiptCommitment } = require("../../lib/protocol-v2");
const { createCircuitFixture, CIRCUIT_FIXTURE_DOMAIN_HASH } = require("../../lib/v2/circuit-fixture");

const project = path.resolve(__dirname, "../..");
const output = path.resolve(project, process.env.JNCA_CIRCUIT_OUTPUT || "reproducibility/issue01-03-20261015/circuit");
if (!output.startsWith(project + path.sep)) throw new Error("circuit output must remain inside JNCA");
const wasm = path.join(project, "circuits/v2/build/zk_crossagent_v2_js/zk_crossagent_v2.wasm");
const r1cs = path.join(project, "circuits/v2/build/zk_crossagent_v2.r1cs");

async function worker() {
  const input = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  try {
    await snarkjs.wtns.calculate(input, wasm, process.argv[4], { singleThread: true });
    throw new Error("invalid input produced a witness");
  } catch (error) {
    if (!/Assert Failed/.test(String(error.message))) throw error;
    console.log("EXPECTED_CONSTRAINT_REJECTION", error.message);
  }
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  assert(fs.existsSync(wasm) && fs.existsSync(r1cs), "compiled circuit files are required");
  const poseidon = await buildPoseidon();
  const cases = [
    ["count-minimum", true, (f) => { f.child.maxSubcalls = 1; }],
    ["count-maximum", true, (f) => { f.child.maxSubcalls = f.root.maxSubcalls; }],
    ["receipt-before-deadline", true, (f) => { f.receipt.economics.createdAt = f.child.expiry - 1; }],
    ["receipt-at-deadline", true, (f) => { f.receipt.economics.createdAt = f.child.expiry; }],
    ["zero-child-count", false, (f) => { f.child.maxSubcalls = 0; }],
    ["child-count-above-root", false, (f) => { f.child.maxSubcalls = f.root.maxSubcalls + 1; }],
    ["receipt-after-child-expiry", false, (f) => { f.receipt.economics.createdAt = f.child.expiry + 1; }],
    ["receipt-after-root-expiry", false, (f) => { f.receipt.economics.createdAt = f.root.expiry + 1; }],
    ["child-expiry-above-root", false, (f) => { f.child.expiry = f.root.expiry + 1; }],
  ];
  const results = [];
  for (const [name, valid, mutate] of cases) {
    const f = createCircuitFixture(poseidon);
    mutate(f);
    // Recompute all dependent commitments, so rejection exercises the intended bound.
    f.root.capabilityCommitment = computeRootCapabilityCommitment(poseidon, f.root).toString();
    f.child.parentCommitment = f.root.capabilityCommitment;
    f.child.capabilityCommitment = computeChildCapabilityCommitment(poseidon, f.child).toString();
    f.receipt.identity.rootCommitment = f.root.capabilityCommitment;
    f.receipt.identity.childCommitment = f.child.capabilityCommitment;
    f.receipt.receiptCommitment = computeReceiptCommitment(poseidon, f.receipt).toString();
    const built = buildCircuitInput(poseidon, [f], {
      settlementDomainHash: CIRCUIT_FIXTURE_DOMAIN_HASH, batchEpoch: results.length + 1,
    });
    const inputPath = path.join(output, name + ".json");
    const witnessPath = path.join(output, name + ".wtns");
    fs.writeFileSync(inputPath, JSON.stringify(built.input, null, 2) + "\n");
    if (valid) {
      await snarkjs.wtns.calculate(built.input, wasm, witnessPath, { singleThread: true });
      assert.strictEqual(await snarkjs.wtns.check(r1cs, witnessPath), true, name);
    } else {
      const child = spawnSync(process.execPath, [__filename, "--negative", inputPath, witnessPath],
        { encoding: "utf8", timeout: 120_000 });
      fs.writeFileSync(path.join(output, name + ".log"), (child.stdout || "") + (child.stderr || ""));
      assert.strictEqual(child.status, 0, name + ": " + child.stderr);
      assert.match(child.stdout, /EXPECTED_CONSTRAINT_REJECTION/, name);
    }
    results.push({ name, expected: valid ? "accept" : "reject", passed: true });
    console.log("PASS", name, valid ? "valid R1CS witness" : "constraint rejection");
  }
  fs.writeFileSync(path.join(output, "results.json"),
    JSON.stringify({ cases: results.length, passed: results.length, results }, null, 2) + "\n");
}
(process.argv[2] === "--negative" ? worker() : main())
  .then(() => process.exit(0))
  .catch((error) => { console.error(error); process.exit(1); });

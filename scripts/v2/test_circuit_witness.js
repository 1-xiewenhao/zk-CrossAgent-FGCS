const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const snarkjs = require("snarkjs");
const { buildPoseidon } = require("circomlibjs");
const {
  buildCircuitInput,
} = require("../../lib/protocol-v2");
const {
  CIRCUIT_FIXTURE_DOMAIN_HASH,
  createCircuitFixture,
} = require("../../lib/v2/circuit-fixture");

const WASM_PATH = path.resolve(
  __dirname,
  "../../circuits/v2/build/zk_crossagent_v2_js/zk_crossagent_v2.wasm"
);
async function calculateWitness(input, outputPath) {
  await snarkjs.wtns.calculate(input, WASM_PATH, outputPath, {
    singleThread: true,
  });
  return snarkjs.wtns.exportJson(outputPath);
}

async function expectInvalidWitness(label, input, outputPath) {
  const inputPath = `${outputPath}.json`;
  fs.writeFileSync(inputPath, JSON.stringify(input));
  const worker = spawnSync(
    process.execPath,
    [__filename, "--negative-worker", inputPath, outputPath],
    { stdio: "ignore" }
  );
  assert.strictEqual(
    worker.status,
    0,
    `${label} unexpectedly produced a valid witness`
  );
  process.stdout.write(`PASS invalid witness rejected: ${label}\n`);
}

async function runNegativeWorker() {
  const [, , , inputPath, outputPath] = process.argv;
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  try {
    await calculateWitness(input, outputPath);
    process.exitCode = 1;
  } catch (_error) {
    process.exitCode = 0;
  }
}

async function main() {
  assert(fs.existsSync(WASM_PATH), `missing compiled circuit: ${WASM_PATH}`);
  const poseidon = await buildPoseidon();
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "zk-crossagent-v2-witness-")
  );

  try {
    const valid = buildCircuitInput(poseidon, [createCircuitFixture(poseidon)], {
      settlementDomainHash: CIRCUIT_FIXTURE_DOMAIN_HASH,
      batchEpoch: 1,
    });
    const witness = await calculateWitness(
      valid.input,
      path.join(temporaryDirectory, "valid.wtns")
    );
    assert.strictEqual(
      BigInt(witness[1]),
      valid.expectedBatchRoot,
      "circuit batch root differs from the JavaScript Poseidon tree"
    );
    process.stdout.write("PASS valid witness and batch root equivalence\n");

    const permissionEscalation = buildCircuitInput(
      poseidon,
      [
        createCircuitFixture(poseidon, {
          rootPermissions: 1,
          childPermissions: 2,
        }),
      ],
      {
        settlementDomainHash: CIRCUIT_FIXTURE_DOMAIN_HASH,
        batchEpoch: 2,
      }
    );
    await expectInvalidWitness(
      "child permission escalation",
      permissionEscalation.input,
      path.join(temporaryDirectory, "permission-escalation.wtns")
    );

    const budgetEscalation = buildCircuitInput(
      poseidon,
      [
        createCircuitFixture(poseidon, {
          rootBudget: 100,
          childBudget: 101,
        }),
      ],
      {
        settlementDomainHash: CIRCUIT_FIXTURE_DOMAIN_HASH,
        batchEpoch: 3,
      }
    );
    await expectInvalidWitness(
      "child budget exceeds root budget",
      budgetEscalation.input,
      path.join(temporaryDirectory, "budget-escalation.wtns")
    );

    const forgedReceipt = buildCircuitInput(
      poseidon,
      [createCircuitFixture(poseidon)],
      {
        settlementDomainHash: CIRCUIT_FIXTURE_DOMAIN_HASH,
        batchEpoch: 4,
      }
    );
    forgedReceipt.input.receiptCommitment[0] = (
      BigInt(forgedReceipt.input.receiptCommitment[0]) + 1n
    ).toString();
    await expectInvalidWitness(
      "forged receipt commitment",
      forgedReceipt.input,
      path.join(temporaryDirectory, "forged-receipt.wtns")
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const operation =
  process.argv[2] === "--negative-worker" ? runNegativeWorker : main;
operation().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

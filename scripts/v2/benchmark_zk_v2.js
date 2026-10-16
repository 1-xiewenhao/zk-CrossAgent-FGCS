const fs = require("fs");
const os = require("os");
const path = require("path");
const snarkjs = require("snarkjs");
const { buildPoseidon } = require("circomlibjs");
const { buildCircuitInput } = require("../../lib/protocol-v2");
const {
  CIRCUIT_FIXTURE_DOMAIN_HASH,
  createCircuitFixture,
} = require("../../lib/v2/circuit-fixture");
const {
  nowMilliseconds,
  sha256File,
  summarize,
  writeCsv,
  writeJson,
  writeJsonLines,
} = require("../../lib/v2/experiment-utils");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const DEFAULT_CONFIG_PATH = path.join(
  PROJECT_ROOT,
  "experiments/v2/configs/submission-local-20261015.json"
);
const WASM_PATH = path.join(
  PROJECT_ROOT,
  "circuits/v2/build/zk_crossagent_v2_js/zk_crossagent_v2.wasm"
);
const ZKEY_PATH = path.join(
  PROJECT_ROOT,
  "circuits/v2/setup/zk_crossagent_v2_final.zkey"
);
const VERIFICATION_KEY_PATH = path.join(
  PROJECT_ROOT,
  "circuits/v2/evidence/verification_key.json"
);

async function main() {
  const configPath = path.resolve(process.argv[2] || DEFAULT_CONFIG_PATH);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  for (const required of [WASM_PATH, ZKEY_PATH, VERIFICATION_KEY_PATH]) {
    if (!fs.existsSync(required)) throw new Error(`missing artifact: ${required}`);
  }
  const outputDirectory = path.resolve(
    process.env.EXPERIMENT_OUTPUT ||
      path.join(PROJECT_ROOT, "experiments/v2/results", config.campaignId)
  );
  fs.mkdirSync(outputDirectory, { recursive: true });
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "zk-crossagent-zk-benchmark-")
  );
  const poseidon = await buildPoseidon();
  const verificationKey = JSON.parse(
    fs.readFileSync(VERIFICATION_KEY_PATH, "utf8")
  );
  const rawRows = [];
  try {
    for (const realCount of config.zk.realCounts) {
      const fixtures = Array.from({ length: realCount }, (_, index) =>
        createCircuitFixture(poseidon, { fixtureIndex: index + 1 })
      );
      const built = buildCircuitInput(poseidon, fixtures, {
        settlementDomainHash: CIRCUIT_FIXTURE_DOMAIN_HASH,
        batchEpoch: realCount,
      });
      const rounds = config.zk.warmupRounds + config.zk.measuredRounds;
      for (let round = 0; round < rounds; round += 1) {
        const witnessPath = path.join(
          temporaryDirectory,
          `real-${realCount}-round-${round}.wtns`
        );
        let started = nowMilliseconds();
        await snarkjs.wtns.calculate(built.input, WASM_PATH, witnessPath, {
          singleThread: true,
        });
        const witnessMs = nowMilliseconds() - started;
        started = nowMilliseconds();
        const { proof, publicSignals } = await snarkjs.groth16.prove(
          ZKEY_PATH,
          witnessPath
        );
        const proveMs = nowMilliseconds() - started;
        started = nowMilliseconds();
        const verified = await snarkjs.groth16.verify(
          verificationKey,
          publicSignals,
          proof
        );
        const verifyMs = nowMilliseconds() - started;
        if (!verified) throw new Error("Groth16 benchmark proof failed");
        if (BigInt(publicSignals[0]) !== built.expectedBatchRoot) {
          throw new Error("benchmark public batch root mismatch");
        }
        rawRows.push({
          schemaVersion: 1,
          recordType: "zk_sample",
          campaignId: config.campaignId,
          realCount,
          dummyCount: 16 - realCount,
          round: round + 1,
          warmup: round < config.zk.warmupRounds,
          witnessMs,
          proveMs,
          verifyMs,
          totalMs: witnessMs + proveMs + verifyMs,
          verified,
        });
        fs.rmSync(witnessPath, { force: true });
        console.log(
          `PASS real=${realCount} round=${round + 1} ` +
            `prove=${proveMs.toFixed(1)}ms`
        );
      }
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  const summaries = [];
  for (const realCount of config.zk.realCounts) {
    const samples = rawRows.filter(
      (row) => row.realCount === realCount && !row.warmup
    );
    for (const metric of ["witnessMs", "proveMs", "verifyMs", "totalMs"]) {
      summaries.push({
        campaignId: config.campaignId,
        realCount,
        dummyCount: 16 - realCount,
        metric,
        ...summarize(samples.map((sample) => sample[metric])),
      });
    }
  }
  const rawPath = path.join(outputDirectory, "zk_raw.jsonl");
  const summaryJsonPath = path.join(outputDirectory, "zk_summary.json");
  const summaryCsvPath = path.join(outputDirectory, "zk_summary.csv");
  writeJsonLines(rawPath, rawRows);
  writeJson(summaryJsonPath, summaries);
  writeCsv(summaryCsvPath, summaries);

  const manifestPath = path.join(outputDirectory, "manifest.json");
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : { schemaVersion: 1, campaignId: config.campaignId, files: {}, modes: {} };
  manifest.modes.zkLocal = "completed";
  manifest.zkArtifacts = {
    wasmSha256: sha256File(WASM_PATH),
    finalZkeySha256: sha256File(ZKEY_PATH),
    verificationKeySha256: sha256File(VERIFICATION_KEY_PATH),
  };
  for (const filePath of [rawPath, summaryJsonPath, summaryCsvPath]) {
    const name = path.basename(filePath);
    manifest.files[name] = {
      sha256: sha256File(filePath),
      sizeBytes: fs.statSync(filePath).size,
    };
  }
  writeJson(manifestPath, manifest);
  console.log(`PASS ZK campaign: ${rawRows.length} proofs`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

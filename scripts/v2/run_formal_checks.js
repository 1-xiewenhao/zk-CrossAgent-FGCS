const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const MODEL_PATH = path.join(
  PROJECT_ROOT,
  "formal/proverif/zk_crossagent_v2.pv"
);
const STATE_MODEL_PATH = path.join(
  PROJECT_ROOT,
  "formal/state-model/check_state_model.js"
);
const EVIDENCE_DIRECTORY = path.join(PROJECT_ROOT, "formal/evidence");
const PROVERIF_REPORT_PATH = path.join(
  EVIDENCE_DIRECTORY,
  "proverif_report.json"
);
const PROVERIF_RESULTS_PATH = path.join(
  EVIDENCE_DIRECTORY,
  "proverif_results.txt"
);

function digest(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function run(command, argumentsValue) {
  const result = spawnSync(command, argumentsValue, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} exited ${result.status}\n${result.stdout}\n${result.stderr}`
    );
  }
  return `${result.stdout}${result.stderr}`;
}

fs.mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });
const proverifOutput = run("opam", [
  "exec",
  "--",
  "proverif",
  MODEL_PATH,
]);
const resultLines = proverifOutput
  .split(/\r?\n/)
  .filter((line) => line.startsWith("RESULT "));
if (resultLines.length !== 12) {
  throw new Error(
    `expected 12 ProVerif results, received ${resultLines.length}`
  );
}
const failedResults = resultLines.filter(
  (line) => !line.endsWith(" is true.")
);
if (failedResults.length > 0) {
  throw new Error(`ProVerif query failed:\n${failedResults.join("\n")}`);
}
const helpOutput = run("opam", ["exec", "--", "proverif", "-help"]);
const versionMatch = helpOutput.match(
  /Proverif\s+([0-9]+(?:\.[0-9]+)*)/i
);
const report = {
  model: "zk-CrossAgent v2 symbolic authentication model",
  proverifVersion: versionMatch ? versionMatch[1] : "unknown",
  modelSha256: digest(MODEL_PATH),
  publicAttackerChannel: true,
  activeDolevYaoCapabilities: [
    "observe",
    "drop",
    "delay",
    "reorder",
    "duplicate",
    "replay",
    "construct public terms",
  ],
  queryCount: resultLines.length,
  result: "PASS",
  results: resultLines,
  interpretation: {
    authentication:
      "settlement correspondence and two injective signature-stage correspondences",
    exactlyOnce:
      "checked by the explicit state model and implementation fault tests",
    atomicStateAbstraction:
      "linear private permits model atomic consumed-call contract storage; all protocol messages remain public",
  },
};
fs.writeFileSync(
  PROVERIF_REPORT_PATH,
  `${JSON.stringify(report, null, 2)}\n`
);
fs.writeFileSync(
  PROVERIF_RESULTS_PATH,
  `${resultLines.join("\n")}\n`
);
console.log(`PASS ProVerif: ${resultLines.length} queries`);

const stateOutput = run(process.execPath, [STATE_MODEL_PATH]);
process.stdout.write(stateOutput);

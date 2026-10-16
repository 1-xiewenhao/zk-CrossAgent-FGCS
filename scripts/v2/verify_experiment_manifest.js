const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const RESULTS_ROOT = path.join(PROJECT_ROOT, "experiments/v2/results");
const manifestPath = path.resolve(
  process.argv[2] ||
    path.join(
      RESULTS_ROOT,
      "phase-e-local-full-v1",
      "LOCAL_RESULTS_MANIFEST.json"
    )
);

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const failures = [];
for (const entry of manifest.evidenceFiles) {
  const filePath = path.resolve(RESULTS_ROOT, ...entry.path.split("/"));
  if (!filePath.startsWith(`${RESULTS_ROOT}${path.sep}`)) {
    failures.push(`${entry.path}: escapes results root`);
    continue;
  }
  if (!fs.existsSync(filePath)) {
    failures.push(`${entry.path}: missing`);
    continue;
  }
  const sizeBytes = fs.statSync(filePath).size;
  const digest = sha256(filePath);
  if (sizeBytes !== entry.sizeBytes || digest !== entry.sha256) {
    failures.push(`${entry.path}: size or SHA-256 mismatch`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`PASS evidence manifest: ${manifest.evidenceFiles.length} files`);

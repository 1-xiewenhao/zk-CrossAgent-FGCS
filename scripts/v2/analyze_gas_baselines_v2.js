const fs = require("fs");
const path = require("path");
const {
  sha256File,
  summarize,
  writeCsv,
  writeJson,
  writeJsonLines,
} = require("../../lib/v2/experiment-utils");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const DEFAULT_CAMPAIGN = "phase-e-local-fault-gas-full-v1";

function parseJsonLines(filePath) {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function operationValues(rows, operation) {
  const values = rows.filter((row) => row.operation === operation).map((row) => row.gasUsed);
  if (values.length === 0) throw new Error(`missing gas samples: ${operation}`);
  return values;
}

function main() {
  const campaignId = process.argv[2] || DEFAULT_CAMPAIGN;
  const outputDirectory = path.join(PROJECT_ROOT, "experiments/v2/results", campaignId);
  const gasRows = parseJsonLines(path.join(outputDirectory, "local_gas_raw.jsonl"));
  const accept = operationValues(gasRows, "accept_batch_root");
  const settle = operationValues(gasRows, "settle_receipt");
  const verify = operationValues(gasRows, "verify_groth16_batch");
  const repeats = Math.min(accept.length, settle.length, verify.length);
  if (repeats < 2) throw new Error("at least two matched repetitions are required");

  const rawRows = [];
  for (const realCount of [1, 4, 8, 16]) {
    for (let index = 0; index < repeats; index += 1) {
      const common = {
        schemaVersion: 1,
        recordType: "gas_policy_baseline_sample",
        campaignId,
        round: index + 1,
        realCount,
        settlementGas: settle[index],
        batchRootGas: accept[index],
      };
      rawRows.push({
        ...common,
        policy: "zk_batch_amortized",
        verifierGas: verify[index],
        gasPerReceipt: settle[index] + (accept[index] + verify[index]) / realCount,
      });
      rawRows.push({
        ...common,
        policy: "non_zk_batch_amortized",
        verifierGas: 0,
        gasPerReceipt: settle[index] + accept[index] / realCount,
      });
    }
  }

  const summaries = [];
  for (const policy of ["zk_batch_amortized", "non_zk_batch_amortized"]) {
    for (const realCount of [1, 4, 8, 16]) {
      const values = rawRows
        .filter((row) => row.policy === policy && row.realCount === realCount)
        .map((row) => row.gasPerReceipt);
      summaries.push({
        campaignId,
        network: "hardhat-local",
        policy,
        realCount,
        metric: "gasPerReceipt",
        derivation: policy === "zk_batch_amortized"
          ? "settlementGas + (batchRootGas + verifierGas) / realCount"
          : "settlementGas + batchRootGas / realCount",
        ...summarize(values),
      });
    }
  }

  const find = (policy, realCount) => summaries.find(
    (row) => row.policy === policy && row.realCount === realCount
  );
  const zkSingle = find("zk_batch_amortized", 1);
  const zkFull = find("zk_batch_amortized", 16);
  const nonZkFull = find("non_zk_batch_amortized", 16);
  const comparisons = [
    {
      campaignId,
      comparison: "full_batch_zk_vs_single_call_zk",
      numeratorPolicy: "zk_batch_amortized",
      numeratorRealCount: 16,
      denominatorPolicy: "zk_batch_amortized",
      denominatorRealCount: 1,
      numeratorMeanGas: zkFull.mean,
      denominatorMeanGas: zkSingle.mean,
      relativeChange: (zkFull.mean - zkSingle.mean) / zkSingle.mean,
    },
    {
      campaignId,
      comparison: "full_batch_zk_vs_full_batch_non_zk",
      numeratorPolicy: "zk_batch_amortized",
      numeratorRealCount: 16,
      denominatorPolicy: "non_zk_batch_amortized",
      denominatorRealCount: 16,
      numeratorMeanGas: zkFull.mean,
      denominatorMeanGas: nonZkFull.mean,
      relativeChange: (zkFull.mean - nonZkFull.mean) / nonZkFull.mean,
    },
  ];

  const rawPath = path.join(outputDirectory, "gas_policy_baseline_raw.jsonl");
  const summaryPath = path.join(outputDirectory, "gas_policy_baseline_summary.json");
  const csvPath = path.join(outputDirectory, "gas_policy_baseline_summary.csv");
  const comparisonPath = path.join(outputDirectory, "gas_policy_comparisons.json");
  writeJsonLines(rawPath, rawRows);
  writeJson(summaryPath, summaries);
  writeCsv(csvPath, summaries);
  writeJson(comparisonPath, comparisons);

  const manifestPath = path.join(outputDirectory, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.modes.gasPolicyBaselines = "completed-derived-from-local-transactions";
  manifest.gasPolicyBaseline = {
    matchedRepetitions: repeats,
    note: "Execution-policy comparison derived from repeated transactions on the same deployment; not a separate baseline contract.",
  };
  for (const filePath of [rawPath, summaryPath, csvPath, comparisonPath]) {
    manifest.files[path.basename(filePath)] = {
      sha256: sha256File(filePath),
      sizeBytes: fs.statSync(filePath).size,
    };
  }
  writeJson(manifestPath, manifest);
  console.log(
    `PASS gas policy baselines: ${repeats} matched rounds; ` +
      `batch-vs-single=${(comparisons[0].relativeChange * 100).toFixed(2)}%; ` +
      `zk-vs-non-zk=${(comparisons[1].relativeChange * 100).toFixed(2)}%`
  );
}

main();

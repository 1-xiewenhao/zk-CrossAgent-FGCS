const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DurableRelayerV2 } = require("../../lib/v2/durable-relayer");
const {
  commandOutput,
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
  "experiments/v2/configs/submission-fault-gas-20261015.json"
);

function hex(label, bytes = 32) {
  return `0x${crypto.createHash("sha256").update(label).digest("hex").slice(0, bytes * 2)}`;
}

class SourceAdapter {
  constructor(blockNumber, blockHash, finalityDepth) {
    this.blockNumber = blockNumber + finalityDepth - 1;
    this.hashes = new Map([[blockNumber, blockHash]]);
  }
  async getBlockNumber() { return this.blockNumber; }
  async getBlockHash(blockNumber) { return this.hashes.get(blockNumber) || null; }
}

class DestinationAdapter {
  constructor(job, failureMode) {
    this.job = job;
    this.failureMode = failureMode;
    this.applied = false;
    this.applications = 0;
    this.broadcasts = 0;
    this.receipt = null;
  }
  async isApplied() { return this.applied; }
  async prepare() {
    const rawTransaction = hex(`raw:${this.job.jobKey}`);
    return { rawTransaction, transactionHash: hex(`tx:${rawTransaction}`) };
  }
  async getTransactionReceipt() { return this.receipt; }
  async broadcastRawTransaction(rawTransaction) {
    this.broadcasts += 1;
    if (this.failureMode === "reject-once") {
      this.failureMode = null;
      throw new Error("temporary RPC rejection");
    }
    if (!this.applied) {
      this.applied = true;
      this.applications += 1;
    }
    this.receipt = { status: 1, transactionHash: hex(`tx:${rawTransaction}`) };
    if (this.failureMode === "accept-then-timeout") {
      this.failureMode = null;
      throw new Error("RPC response lost after broadcast");
    }
    return this.receipt.transactionHash;
  }
}

async function createFinalizedJob(databasePath, config, iteration) {
  const relayer = new DurableRelayerV2(databasePath, {
    finalityDepth: config.faults.finalityDepth,
    clock: () => 1_900_000_000_000 + iteration,
  });
  const event = {
    sourceChainId: 80002,
    sourceContract: "0x1000000000000000000000000000000000000001",
    batchEpoch: iteration,
    batchRoot: hex(`root:${iteration}`),
    sourceTransactionHash: hex(`source-tx:${iteration}`),
    sourceBlockNumber: 1000 + iteration,
    sourceBlockHash: hex(`source-block:${iteration}`),
  };
  const observed = relayer.observeSourceEvent(event);
  const source = new SourceAdapter(
    event.sourceBlockNumber,
    event.sourceBlockHash,
    config.faults.finalityDepth
  );
  await relayer.reconcileSource(observed.eventKey, source);
  const job = relayer.enqueueFinalizedRelay(observed.eventKey);
  return { event, job, relayer, source };
}

function reopen(databasePath, config, iteration) {
  return new DurableRelayerV2(databasePath, {
    finalityDepth: config.faults.finalityDepth,
    clock: () => 1_900_000_000_000 + iteration,
  });
}

async function runScenario(config, scenario, iteration, warmup) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "zk-crossagent-fault-benchmark-")
  );
  const databasePath = path.join(temporaryDirectory, "relayer.sqlite");
  let relayer;
  const totalStarted = nowMilliseconds();
  try {
    const setup = await createFinalizedJob(databasePath, config, iteration);
    relayer = setup.relayer;
    const destination = new DestinationAdapter(setup.job, null);
    if (scenario === "persist_before_broadcast_crash") {
      try {
        await relayer.processDestinationJob(setup.job.jobKey, destination, {
          afterPersistBeforeBroadcast: async () => {
            throw new Error("injected crash");
          },
        });
      } catch (error) {
        if (!error.message.includes("injected crash")) throw error;
      }
    } else if (scenario === "rpc_accept_then_timeout") {
      destination.failureMode = "accept-then-timeout";
      try {
        await relayer.processDestinationJob(setup.job.jobKey, destination);
      } catch (error) {
        if (!error.message.includes("response lost")) throw error;
      }
    } else if (scenario === "rpc_reject_then_retry") {
      destination.failureMode = "reject-once";
      try {
        await relayer.processDestinationJob(setup.job.jobKey, destination);
      } catch (error) {
        if (!error.message.includes("temporary RPC rejection")) throw error;
      }
    } else {
      throw new Error(`unknown scenario ${scenario}`);
    }
    relayer.close();
    const recoveryStarted = nowMilliseconds();
    relayer = reopen(databasePath, config, iteration);
    const recovered = await relayer.processDestinationJob(
      setup.job.jobKey,
      destination
    );
    const recoveryMs = nowMilliseconds() - recoveryStarted;
    if (recovered.status !== "CONFIRMED" || destination.applications !== 1) {
      throw new Error("recovery did not preserve exactly-once application");
    }
    return {
      schemaVersion: 1,
      recordType: "fault_recovery_sample",
      campaignId: config.campaignId,
      scenario,
      iteration,
      warmup,
      recoveryMs,
      totalScenarioMs: nowMilliseconds() - totalStarted,
      destinationApplications: destination.applications,
      broadcastAttempts: destination.broadcasts,
      outcome: "success",
    };
  } finally {
    if (relayer?.db?.open) relayer.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function runReorgScenario(config, iteration, warmup) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "zk-crossagent-reorg-benchmark-")
  );
  const databasePath = path.join(temporaryDirectory, "relayer.sqlite");
  let relayer;
  const totalStarted = nowMilliseconds();
  try {
    relayer = new DurableRelayerV2(databasePath, {
      finalityDepth: config.faults.finalityDepth,
      clock: () => 1_900_100_000_000 + iteration,
    });
    const event = {
      sourceChainId: 80002,
      sourceContract: "0x1000000000000000000000000000000000000001",
      batchEpoch: iteration,
      batchRoot: hex(`reorg-root:${iteration}`),
      sourceTransactionHash: hex(`orphaned-tx:${iteration}`),
      sourceBlockNumber: 2000 + iteration,
      sourceBlockHash: hex(`orphaned-block:${iteration}`),
    };
    const observed = relayer.observeSourceEvent(event);
    const orphanedSource = new SourceAdapter(
      event.sourceBlockNumber,
      hex(`canonical-other-block:${iteration}`),
      config.faults.finalityDepth
    );
    const reorged = await relayer.reconcileSource(
      observed.eventKey,
      orphanedSource
    );
    if (reorged.status !== "REORGED" || reorged.reorgCount !== 1) {
      throw new Error("temporary fork was not marked reorged");
    }
    try {
      relayer.enqueueFinalizedRelay(observed.eventKey);
      throw new Error("reorged source event was incorrectly relayable");
    } catch (error) {
      if (!error.message.includes("has not reached finality")) throw error;
    }

    const recoveryStarted = nowMilliseconds();
    const replacement = {
      ...event,
      sourceTransactionHash: hex(`replacement-tx:${iteration}`),
      sourceBlockHash: hex(`replacement-block:${iteration}`),
    };
    relayer.observeSourceEvent(replacement);
    const canonicalSource = new SourceAdapter(
      replacement.sourceBlockNumber,
      replacement.sourceBlockHash,
      config.faults.finalityDepth
    );
    const finalized = await relayer.reconcileSource(
      observed.eventKey,
      canonicalSource
    );
    if (finalized.status !== "FINALIZED") {
      throw new Error("replacement event did not reach finality");
    }
    const job = relayer.enqueueFinalizedRelay(observed.eventKey);
    const destination = new DestinationAdapter(job, null);
    const recovered = await relayer.processDestinationJob(job.jobKey, destination);
    const recoveryMs = nowMilliseconds() - recoveryStarted;
    if (recovered.status !== "CONFIRMED" || destination.applications !== 1) {
      throw new Error("reorg recovery did not preserve exactly-once application");
    }
    return {
      schemaVersion: 1,
      recordType: "fault_recovery_sample",
      campaignId: config.campaignId,
      scenario: "temporary_fork_reorg",
      iteration,
      warmup,
      recoveryMs,
      totalScenarioMs: nowMilliseconds() - totalStarted,
      destinationApplications: destination.applications,
      broadcastAttempts: destination.broadcasts,
      reorgDetections: 1,
      outcome: "success",
    };
  } finally {
    if (relayer?.db?.open) relayer.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const configPath = path.resolve(process.argv[2] || DEFAULT_CONFIG_PATH);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const outputDirectory = path.resolve(
    process.env.EXPERIMENT_OUTPUT ||
      path.join(PROJECT_ROOT, "experiments/v2/results", config.campaignId)
  );
  const scenarios = [
    "persist_before_broadcast_crash",
    "rpc_accept_then_timeout",
    "rpc_reject_then_retry",
    "temporary_fork_reorg",
  ];
  const rawRows = [];
  const rounds = config.faults.warmupRounds + config.faults.measuredRounds;
  for (const scenario of scenarios) {
    for (let round = 0; round < rounds; round += 1) {
      const iteration = scenarios.indexOf(scenario) * 10_000 + round + 1;
      const warmup = round < config.faults.warmupRounds;
      rawRows.push(
        scenario === "temporary_fork_reorg"
          ? await runReorgScenario(config, iteration, warmup)
          : await runScenario(config, scenario, iteration, warmup)
      );
    }
    console.log(`PASS ${scenario}: ${rounds} rounds`);
  }
  const summaryRows = scenarios.map((scenario) => {
    const rows = rawRows.filter((row) => row.scenario === scenario && !row.warmup);
    return {
      campaignId: config.campaignId,
      scenario,
      metric: "recoveryMs",
      ...summarize(rows.map((row) => row.recoveryMs)),
      duplicateApplications: rows.reduce(
        (sum, row) => sum + Math.max(0, row.destinationApplications - 1),
        0
      ),
      reorgDetections: rows.reduce(
        (sum, row) => sum + (row.reorgDetections || 0),
        0
      ),
    };
  });
  fs.mkdirSync(outputDirectory, { recursive: true });
  const rawPath = path.join(outputDirectory, "fault_raw.jsonl");
  const summaryJsonPath = path.join(outputDirectory, "fault_summary.json");
  const summaryCsvPath = path.join(outputDirectory, "fault_summary.csv");
  writeJsonLines(rawPath, rawRows);
  writeJson(summaryJsonPath, summaryRows);
  writeCsv(summaryCsvPath, summaryRows);
  const manifestPath = path.join(outputDirectory, "manifest.json");
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : { schemaVersion: 1, files: {}, modes: {} };
  manifest.campaignId = config.campaignId;
  manifest.campaignClass = config.campaignClass;
  manifest.generatedAt = new Date().toISOString();
  manifest.configPath = path.relative(PROJECT_ROOT, configPath);
  manifest.configSha256 = sha256File(configPath);
  manifest.git = {
    commit: commandOutput("git", ["rev-parse", "HEAD"], PROJECT_ROOT),
    branch: commandOutput("git", ["branch", "--show-current"], PROJECT_ROOT),
    trackedStatus:
      commandOutput(
        "git",
        ["status", "--porcelain", "--untracked-files=no"],
        PROJECT_ROOT
      ) || "",
  };
  manifest.host = {
    platform: os.platform(),
    release: os.release(),
    architecture: os.arch(),
  };
  manifest.modes.faultRecoveryLocal = "completed-with-reorg-injection";
  for (const filePath of [rawPath, summaryJsonPath, summaryCsvPath]) {
    const name = path.basename(filePath);
    manifest.files[name] = {
      sha256: sha256File(filePath),
      sizeBytes: fs.statSync(filePath).size,
    };
  }
  writeJson(manifestPath, manifest);
  console.log(`PASS fault campaign: ${rawRows.length} samples`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

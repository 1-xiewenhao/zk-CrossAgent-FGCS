const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const { buildPoseidon } = require("circomlibjs");
const {
  PROTOCOL_VERSION,
  ROOT_CAPABILITY_TYPES,
  CHILD_CAPABILITY_TYPES,
  CALLER_CONFIRMATION_TYPES,
  eip712Domain,
  rootCapabilityTypedValue,
  childCapabilityTypedValue,
  settlementDomainHash,
  computeRootCapabilityCommitment,
  computeChildCapabilityCommitment,
  callerConfirmation,
} = require("../../lib/protocol-v2");
const {
  PersistentProtocolState,
} = require("../../lib/v2/persistent-state");
const {
  SecureGatewayV2,
  decryptDelivery,
} = require("../../lib/v2/secure-gateway");
const { verifyCommittedDelivery } = require("../../lib/v2/delivery-validation");
const {
  commandOutput,
  nowMilliseconds,
  seededRandom,
  sha256File,
  sleep,
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

function deterministicWallet(seed, label) {
  const key = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(`zk-crossagent-experiment:${seed}:${label}`)
  );
  return new ethers.Wallet(key);
}

function experimentHash(seed, label) {
  return ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(`zk-crossagent-experiment:${seed}:${label}`)
  );
}

async function createEnvironment({ config, settingId, totalCalls }) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "zk-crossagent-experiment-")
  );
  const state = new PersistentProtocolState(
    path.join(temporaryDirectory, "protocol.sqlite"),
    { clock: () => 1_900_000_000 }
  );
  const poseidon = await buildPoseidon();
  const payer = deterministicWallet(config.randomSeed, `payer:${settingId}`);
  const buyer = deterministicWallet(config.randomSeed, `buyer:${settingId}`);
  const provider = deterministicWallet(config.randomSeed, `provider:${settingId}`);
  const orchestrator = deterministicWallet(
    config.randomSeed,
    `orchestrator:${settingId}`
  );
  const domain = eip712Domain(
    31337,
    "0x5000000000000000000000000000000000000005"
  );
  const domainHash = settlementDomainHash({
    serviceChainId: 80002,
    serviceRegistry: "0x6000000000000000000000000000000000000006",
    settlementChainId: 31337,
    settlementContract: domain.verifyingContract,
  });
  const masterKey = Buffer.from(
    ethers.utils.arrayify(
      experimentHash(config.randomSeed, `master:${settingId}`)
    )
  );
  const gateway = new SecureGatewayV2({
    state,
    poseidon,
    eip712Domain: domain,
    settlementDomainHash: domainHash,
    providerSigner: provider,
    masterKey,
    clock: () => 1_900_000_000,
  });
  const root = {
    protocolVersion: PROTOCOL_VERSION,
    issuer: payer.address,
    payer: payer.address,
    buyer: buyer.address,
    taskId: experimentHash(config.randomSeed, `task:${settingId}`),
    permissions: 7,
    budget: totalCalls * 10,
    expiry: 1_900_003_600,
    maxSubcalls: totalCalls,
    nonce: 1,
    scopeHash: experimentHash(config.randomSeed, `scope:${settingId}`),
    settlementDomainHash: domainHash,
    capabilityCommitment: "0",
  };
  root.capabilityCommitment = computeRootCapabilityCommitment(
    poseidon,
    root
  ).toString();
  const rootSignature = await payer._signTypedData(
    domain,
    ROOT_CAPABILITY_TYPES,
    rootCapabilityTypedValue(root)
  );
  gateway.registerRoot(root, rootSignature);
  return {
    buyer,
    domain,
    gateway,
    orchestrator,
    poseidon,
    provider,
    root,
    state,
    temporaryDirectory,
  };
}

async function runCall(environment, options) {
  const {
    config,
    settingId,
    iteration,
    payloadBytes,
    wanRttMs,
    ablation,
    warmup,
    scenario,
    concurrency,
    mode = "protocol-only",
    responseFactory = null,
  } = options;
  const timings = {};
  let actualPayloadBytes = payloadBytes;
  const totalStarted = nowMilliseconds();
  const child = {
    protocolVersion: PROTOCOL_VERSION,
    issuer: environment.root.issuer,
    buyer: environment.root.buyer,
    provider: environment.provider.address,
    parentCommitment: environment.root.capabilityCommitment,
    taskId: environment.root.taskId,
    permissions: 3,
    budget: 8,
    expiry: environment.root.expiry - 60,
    maxSubcalls: 1,
    nonce: 10_000 + iteration,
    scopeHash: environment.root.scopeHash,
    settlementDomainHash: environment.root.settlementDomainHash,
    capabilityCommitment: "0",
  };
  child.capabilityCommitment = computeChildCapabilityCommitment(
    environment.poseidon,
    child
  ).toString();

  let started = nowMilliseconds();
  const childSignature = await environment.buyer._signTypedData(
    environment.domain,
    CHILD_CAPABILITY_TYPES,
    childCapabilityTypedValue(child)
  );
  timings.delegationSignatureMs = nowMilliseconds() - started;

  await sleep(wanRttMs);
  started = nowMilliseconds();
  const request = {
    operation: mode,
    inputHash: experimentHash(config.randomSeed, `${settingId}:${iteration}`),
  };
  const reserved = environment.gateway.reserveAuthorizedCall({
    root: environment.root,
    child,
    childSignature,
    request,
    providerAmount: 8,
    orchestratorFee: 2,
    orchestrator: environment.orchestrator.address,
  });
  timings.authorizationMs = nowMilliseconds() - started;

  if (ablation !== "authorization_only") {
    await sleep(wanRttMs);
    let responsePayload;
    if (responseFactory) {
      started = nowMilliseconds();
      responsePayload = await responseFactory({ iteration, settingId });
      timings.modelRequestMs = nowMilliseconds() - started;
      if (!Buffer.isBuffer(responsePayload)) {
        responsePayload = Buffer.from(String(responsePayload), "utf8");
      }
    } else {
      responsePayload = Buffer.alloc(payloadBytes, iteration % 251);
    }
    started = nowMilliseconds();
    const committed = await environment.gateway.commitEncryptedResponse(
      reserved.callId,
      responsePayload
    );
    timings.encryptedCommitMs = nowMilliseconds() - started;

    if (ablation === "fair_release") {
      started = nowMilliseconds();
      const confirmation = verifyCommittedDelivery({
        ...committed, poseidon: environment.poseidon, domain: environment.domain,
        root: environment.root, child, request, providerAmount: 8,
        orchestratorFee: 2, orchestrator: environment.orchestrator.address,
      });
      timings.buyerVerificationMs = nowMilliseconds() - started;
      started = nowMilliseconds();
      const buyerSignature = await environment.buyer._signTypedData(
        environment.domain,
        CALLER_CONFIRMATION_TYPES,
        confirmation
      );
      timings.buyerConfirmationSignatureMs = nowMilliseconds() - started;

      await sleep(wanRttMs);
      started = nowMilliseconds();
      const released = await environment.gateway.confirmAndRelease(
        reserved.callId,
        buyerSignature
      );
      timings.keyReleaseMs = nowMilliseconds() - started;
      started = nowMilliseconds();
      const plaintext = decryptDelivery(released);
      timings.decryptMs = nowMilliseconds() - started;
      if (!plaintext.equals(responsePayload)) {
        throw new Error("decrypted payload bytes mismatch");
      }
      actualPayloadBytes = responsePayload.length;
    }
  }

  timings.totalMs = nowMilliseconds() - totalStarted;
  return {
    schemaVersion: 1,
    recordType: "protocol_sample",
    campaignId: config.campaignId,
    settingId,
    scenario,
    mode,
    iteration,
    warmup,
    concurrency,
    wanRttMs,
    simulatedNetworkDelayMs:
      wanRttMs * (ablation === "fair_release" ? 3 : ablation === "committed_delivery" ? 2 : 1),
    payloadBytes: actualPayloadBytes,
    ablation,
    outcome: "success",
    ...timings,
  };
}

async function executeSetting(config, setting) {
  const total = config.protocol.warmupSamples + setting.measuredSamples;
  const environment = await createEnvironment({
    config,
    settingId: setting.settingId,
    totalCalls: total,
  });
  const rows = [];
  try {
    for (
      let offset = 0;
      offset < config.protocol.warmupSamples;
      offset += setting.concurrency
    ) {
      const chunk = [];
      for (
        let index = offset;
        index < Math.min(
          config.protocol.warmupSamples,
          offset + setting.concurrency
        );
        index += 1
      ) {
        chunk.push(
          runCall(environment, {
            config,
            ...setting,
            iteration: index + 1,
            warmup: true,
          })
        );
      }
      rows.push(...(await Promise.all(chunk)));
    }
    const measuredStarted = nowMilliseconds();
    for (
      let offset = 0;
      offset < setting.measuredSamples;
      offset += setting.concurrency
    ) {
      const chunk = [];
      for (
        let index = offset;
        index < Math.min(
          setting.measuredSamples,
          offset + setting.concurrency
        );
        index += 1
      ) {
        chunk.push(
          runCall(environment, {
            config,
            ...setting,
            iteration: config.protocol.warmupSamples + index + 1,
            warmup: false,
          })
        );
      }
      rows.push(...(await Promise.all(chunk)));
    }
    const measuredElapsedMs = nowMilliseconds() - measuredStarted;
    environment.state.assertRootInvariant(
      environment.root.capabilityCommitment
    );
    return {
      rows,
      report: {
        campaignId: config.campaignId,
        scenario: setting.scenario,
        settingId: setting.settingId,
        mode: "protocol-only",
        concurrency: setting.concurrency,
        wanRttMs: setting.wanRttMs,
        payloadBytes: setting.payloadBytes,
        ablation: setting.ablation,
        measuredSamples: setting.measuredSamples,
        measuredElapsedMs,
        throughputOpsPerSecond:
          setting.measuredSamples / (measuredElapsedMs / 1000),
      },
    };
  } finally {
    environment.state.close();
    fs.rmSync(environment.temporaryDirectory, {
      recursive: true,
      force: true,
    });
  }
}

function simulateBatchPolicy(config) {
  const random = seededRandom(config.randomSeed);
  const rows = [];
  for (const rate of config.batchPolicy.arrivalRatesPerSecond) {
    for (const batchSize of config.batchPolicy.batchSizes) {
      for (const timeoutMs of config.batchPolicy.timeoutsMs) {
        const arrivals = [];
        let time = 0;
        for (let index = 0; index < config.batchPolicy.arrivalsPerSetting; index += 1) {
          const uniform = Math.max(random(), Number.EPSILON);
          time += (-Math.log(uniform) / rate) * 1000;
          arrivals.push(time);
        }
        const waits = [];
        let dummySlots = 0;
        let batches = 0;
        let pending = [];
        const flush = (flushTime) => {
          if (pending.length === 0) return;
          for (const arrival of pending) waits.push(flushTime - arrival);
          dummySlots += batchSize - pending.length;
          batches += 1;
          pending = [];
        };
        for (const arrival of arrivals) {
          if (pending.length > 0 && arrival > pending[0] + timeoutMs) {
            flush(pending[0] + timeoutMs);
          }
          pending.push(arrival);
          if (pending.length === batchSize) flush(arrival);
        }
        if (pending.length > 0) flush(pending[0] + timeoutMs);
        rows.push({
          schemaVersion: 1,
          recordType: "batch_policy_summary",
          campaignId: config.campaignId,
          arrivalRatePerSecond: rate,
          batchSize,
          timeoutMs,
          arrivals: arrivals.length,
          batches,
          dummySlots,
          dummyRatio: dummySlots / (batches * batchSize),
          meanFill: arrivals.length / batches,
          waitMs: summarize(waits),
        });
      }
    }
  }
  return rows;
}

function summarizeProtocol(rows, settingReports) {
  const grouped = new Map();
  for (const row of rows.filter((item) => !item.warmup)) {
    const key = [row.scenario, row.settingId, row.ablation].join("|");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const output = [];
  for (const samples of grouped.values()) {
    const first = samples[0];
    for (const metric of [
      "delegationSignatureMs",
      "authorizationMs",
      "modelRequestMs",
      "buyerVerificationMs",
      "encryptedCommitMs",
      "buyerConfirmationSignatureMs",
      "keyReleaseMs",
      "decryptMs",
      "totalMs",
    ]) {
      const values = samples.map((sample) => sample[metric]).filter(Number.isFinite);
      if (values.length === 0) continue;
      const stats = summarize(values);
      output.push({
        campaignId: first.campaignId,
        scenario: first.scenario,
        settingId: first.settingId,
        mode: first.mode,
        concurrency: first.concurrency,
        wanRttMs: first.wanRttMs,
        payloadBytes: first.payloadBytes,
        ablation: first.ablation,
        metric,
        ...stats,
      });
    }
  }
  for (const report of settingReports) {
    output.push({
      ...report,
      metric: "throughputOpsPerSecond",
      count: 1,
      mean: report.throughputOpsPerSecond,
      stddev: 0,
      ci95: [report.throughputOpsPerSecond, report.throughputOpsPerSecond],
      p50: report.throughputOpsPerSecond,
      p95: report.throughputOpsPerSecond,
      p99: report.throughputOpsPerSecond,
      min: report.throughputOpsPerSecond,
      max: report.throughputOpsPerSecond,
    });
  }
  return output;
}

async function main() {
  const configPath = path.resolve(process.argv[2] || DEFAULT_CONFIG_PATH);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const outputDirectory = path.resolve(
    process.env.EXPERIMENT_OUTPUT ||
      path.join(PROJECT_ROOT, "experiments/v2/results", config.campaignId)
  );
  const settings = [];
  for (const concurrency of config.protocol.concurrencyLevels) {
    settings.push({
      settingId: `concurrency-${concurrency}`,
      scenario: "concurrency",
      concurrency,
      wanRttMs: 0,
      payloadBytes: config.protocol.payloadBytes[0],
      ablation: "fair_release",
      measuredSamples: config.protocol.measuredSamples,
    });
  }
  for (const wanRttMs of config.protocol.wanRttMs) {
    settings.push({
      settingId: `wan-rtt-${wanRttMs}`,
      scenario: "wan-simulation",
      concurrency: 1,
      wanRttMs,
      payloadBytes: config.protocol.payloadBytes[0],
      ablation: "fair_release",
      measuredSamples: config.protocol.wanSamples,
    });
  }
  for (const payloadBytes of config.protocol.payloadBytes) {
    settings.push({
      settingId: `payload-${payloadBytes}`,
      scenario: "payload-scan",
      concurrency: 1,
      wanRttMs: 0,
      payloadBytes,
      ablation: "fair_release",
      measuredSamples: config.protocol.measuredSamples,
    });
  }
  for (const ablation of config.protocol.ablations) {
    settings.push({
      settingId: `ablation-${ablation}`,
      scenario: "fair-delivery-ablation",
      concurrency: 1,
      wanRttMs: 0,
      payloadBytes: config.protocol.payloadBytes[0],
      ablation,
      measuredSamples: config.protocol.measuredSamples,
    });
  }

  const rawRows = [];
  const settingReports = [];
  for (const setting of settings) {
    process.stdout.write(`RUN ${setting.settingId}\n`);
    const result = await executeSetting(config, setting);
    rawRows.push(...result.rows);
    settingReports.push(result.report);
  }
  const batchRows = simulateBatchPolicy(config);
  const summaryRows = summarizeProtocol(rawRows, settingReports);
  fs.mkdirSync(outputDirectory, { recursive: true });
  writeJsonLines(path.join(outputDirectory, "protocol_raw.jsonl"), rawRows);
  writeCsv(path.join(outputDirectory, "protocol_summary.csv"), summaryRows);
  writeJson(path.join(outputDirectory, "protocol_summary.json"), summaryRows);
  writeCsv(path.join(outputDirectory, "batch_policy_summary.csv"), batchRows);
  writeJson(path.join(outputDirectory, "batch_policy_summary.json"), batchRows);
  const manifest = {
    schemaVersion: 1,
    campaignId: config.campaignId,
    campaignClass: config.campaignClass,
    generatedAt: new Date().toISOString(),
    configPath: path.relative(PROJECT_ROOT, configPath),
    configSha256: sha256File(configPath),
    git: {
      commit: commandOutput("git", ["rev-parse", "HEAD"], PROJECT_ROOT),
      branch: commandOutput("git", ["branch", "--show-current"], PROJECT_ROOT),
      trackedStatus:
        commandOutput(
          "git",
          ["status", "--porcelain", "--untracked-files=no"],
          PROJECT_ROOT
        ) || "",
    },
    host: {
      platform: os.platform(),
      release: os.release(),
      architecture: os.arch(),
      logicalCpuCount: os.cpus().length,
      cpuModels: [...new Set(os.cpus().map((cpu) => cpu.model))],
      totalMemoryBytes: os.totalmem(),
    },
    runtime: { node: process.version },
    modes: {
      protocolOnly: "completed",
      realLlm: process.env.DEEPSEEK_API_KEY
        ? "configured-not-run"
        : "blocked-missing-key",
      testnetV2:
        process.env.ESCROW_V2_ADDRESS && process.env.REGISTRY_V2_ADDRESS
          ? "configured-not-run"
          : "blocked-missing-v2-addresses",
    },
    files: {},
  };
  for (const name of [
    "protocol_raw.jsonl",
    "protocol_summary.csv",
    "protocol_summary.json",
    "batch_policy_summary.csv",
    "batch_policy_summary.json",
  ]) {
    manifest.files[name] = {
      sha256: sha256File(path.join(outputDirectory, name)),
      sizeBytes: fs.statSync(path.join(outputDirectory, name)).size,
    };
  }
  writeJson(path.join(outputDirectory, "manifest.json"), manifest);
  console.log(
    `PASS protocol campaign: ${rawRows.length} samples, ${batchRows.length} batch settings`
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  createEnvironment,
  runCall,
  summarizeProtocol,
};

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");
const { createEnvironment, runCall } = require("./benchmark_protocol_v2");
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
  "experiments/v2/configs/submission-wan-20261015.json"
);
const LOCAL_PROVIDER_PATH = path.join(__dirname, "wan_provider_stdio.js");

class JsonLineTransport {
  constructor({ label, command, args }) {
    this.label = label;
    this.command = command;
    this.args = args;
    this.sequence = 0;
    this.pending = new Map();
    this.stderr = "";
    this.child = null;
    this.reader = null;
  }

  async start() {
    const started = nowMilliseconds();
    this.child = spawn(this.command, this.args, {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.reader = readline.createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });
    this.reader.on("line", (line) => this._handleLine(line));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
    this.child.on("error", (error) => this._fail(error));
    this.child.on("exit", (code, signal) => {
      this._fail(
        new Error(
          `${this.label} provider exited code=${code} signal=${signal}` +
            (this.stderr ? ` stderr=${this.stderr.trim()}` : "")
        )
      );
    });
    const hello = await this.request({ type: "hello" }, 30000);
    const expectedScriptSha256 = sha256File(LOCAL_PROVIDER_PATH);
    if (hello.scriptSha256 !== expectedScriptSha256) {
      await this.close();
      throw new Error(
        `${this.label} provider script SHA-256 mismatch: ` +
          `expected ${expectedScriptSha256}, received ${hello.scriptSha256}`
      );
    }
    return {
      hello,
      handshakeMs: nowMilliseconds() - started,
    };
  }

  request(message, timeoutMs = 30000) {
    if (!this.child || this.child.exitCode !== null) {
      return Promise.reject(new Error(`${this.label} provider is not running`));
    }
    const requestId = `${this.label}-${process.pid}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${this.label} request timed out: ${requestId}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
      this.child.stdin.write(`${JSON.stringify({ ...message, requestId })}\n`);
    });
  }

  async close() {
    if (!this.child || this.child.exitCode !== null) return;
    try {
      await this.request({ type: "shutdown" }, 2000);
    } catch (_error) {
      // The process may close before the shutdown acknowledgement is read.
    }
    await new Promise((resolve) => {
      if (this.child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        this.child.kill("SIGTERM");
        resolve();
      }, 2000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (this.reader) this.reader.close();
  }

  _handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this._fail(new Error(`${this.label} emitted invalid JSON: ${error.message}`));
      return;
    }
    const pending = this.pending.get(String(message.requestId || ""));
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.requestId);
    if (message.type === "error") pending.reject(new Error(message.error));
    else pending.resolve(message);
  }

  _fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function transportSpec(mode, config) {
  if (mode === "local") {
    return {
      label: "local",
      command: process.execPath,
      args: [LOCAL_PROVIDER_PATH],
    };
  }
  const keyPath = process.env.WAN_SSH_KEY_PATH;
  if (!keyPath && !process.env.SSH_ASKPASS) throw new Error("WAN SSH authentication is required");
  const authentication = keyPath ? ["-i", keyPath, "-o", "BatchMode=yes"] :
    ["-o", "BatchMode=no", "-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "PubkeyAuthentication=no"];
  const knownHostsPath =
    process.env.WAN_KNOWN_HOSTS_PATH || path.join(PROJECT_ROOT, ".codex-runtime/wan-known-hosts");
  return {
    label: "remote",
    command: "ssh",
    args: [
      "-T",
      "-p",
      String(config.remote.port),
      ...authentication,
      "-o",
      "ConnectTimeout=20",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=2",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${knownHostsPath}`,
      "-o",
      "LogLevel=ERROR",
      `${config.remote.user}@${config.remote.host}`,
      config.remote.nodePath || "node",
      config.remote.providerPath,
    ],
  };
}

function createTransport(mode, config) {
  return new JsonLineTransport(transportSpec(mode, config));
}

async function measureRoundTrips(config, mode) {
  const rows = [];
  const transport = createTransport(mode, config);
  const started = await transport.start();
  try {
    const total = config.network.warmupSamples + config.network.roundTripSamples;
    for (let index = 0; index < total; index += 1) {
      const sampleStarted = nowMilliseconds();
      await transport.request({ type: "ping" });
      rows.push({
        schemaVersion: 1,
        recordType: "transport_round_trip",
        campaignId: config.campaignId,
        transportMode: mode,
        iteration: index + 1,
        warmup: index < config.network.warmupSamples,
        roundTripMs: nowMilliseconds() - sampleStarted,
      });
    }
    return { rows, providerHello: started.hello };
  } finally {
    await transport.close();
  }
}

async function measureHandshakes(config, mode) {
  const rows = [];
  const total = config.network.handshakeWarmups + config.network.handshakeSamples;
  let providerHello = null;
  for (let index = 0; index < total; index += 1) {
    const transport = createTransport(mode, config);
    const started = await transport.start();
    providerHello = started.hello;
    rows.push({
      schemaVersion: 1,
      recordType: "transport_handshake",
      campaignId: config.campaignId,
      transportMode: mode,
      iteration: index + 1,
      warmup: index < config.network.handshakeWarmups,
      handshakeMs: started.handshakeMs,
    });
    await transport.close();
  }
  return { rows, providerHello };
}

async function executeProtocolSetting(config, mode, concurrency) {
  const total = config.protocol.warmupSamples + config.protocol.measuredSamples;
  const settingId = `real-wan-${mode}-c${concurrency}`;
  const environment = await createEnvironment({ config, settingId, totalCalls: total });
  const transport = createTransport(mode, config);
  const transportStart = await transport.start();
  const rows = [];
  try {
    const executeRange = async (startIndex, count, warmup) => {
      for (let offset = 0; offset < count; offset += concurrency) {
        const chunkStarted = nowMilliseconds();
        const chunk = [];
        for (let localIndex = offset; localIndex < Math.min(count, offset + concurrency); localIndex += 1) {
          const iteration = startIndex + localIndex + 1;
          let remoteDetail = null;
          chunk.push(
            runCall(environment, {
              config,
              settingId,
              iteration,
              payloadBytes: config.protocol.payloadBytes,
              wanRttMs: 0,
              ablation: "fair_release",
              warmup,
              scenario: "real-wan-provider",
              concurrency,
              responseFactory: async () => {
                const requestStarted = nowMilliseconds();
                const result = await transport.request({
                  type: "invoke",
                  payloadBytes: config.protocol.payloadBytes,
                  serviceDelayMs: config.protocol.serviceDelayMs,
                  seed: config.randomSeed + iteration,
                });
                const networkRoundTripMs = nowMilliseconds() - requestStarted;
                const payload = Buffer.from(result.payloadBase64, "base64");
                const digest = crypto.createHash("sha256").update(payload).digest("hex");
                if (digest !== result.responseSha256) {
                  throw new Error("remote response SHA-256 mismatch");
                }
                remoteDetail = {
                  networkRoundTripMs,
                  remoteServiceMs: result.serviceMs,
                  transportOverheadMs: networkRoundTripMs - result.serviceMs,
                };
                return payload;
              },
            }).then((row) => ({ row, detail: remoteDetail }))
          );
        }
        const completed = await Promise.all(chunk);
        const chunkElapsedMs = nowMilliseconds() - chunkStarted;
        for (const item of completed) {
          rows.push({
            ...item.row,
            recordType: "wan_protocol_sample",
            transportMode: mode,
            chunkElapsedMs,
            ...item.detail,
          });
        }
      }
    };
    await executeRange(0, config.protocol.warmupSamples, true);
    const measuredStarted = nowMilliseconds();
    await executeRange(
      config.protocol.warmupSamples,
      config.protocol.measuredSamples,
      false
    );
    const measuredElapsedMs = nowMilliseconds() - measuredStarted;
    environment.state.assertRootInvariant(environment.root.capabilityCommitment);
    const measured = rows.filter((row) => !row.warmup);
    const firstMeasured = measured[0];
    const lastMeasured = measured[measured.length - 1];
    return {
      rows,
      providerHello: transportStart.hello,
      report: {
        campaignId: config.campaignId,
        transportMode: mode,
        concurrency,
        measuredSamples: measured.length,
        firstMeasuredIteration: firstMeasured.iteration,
        lastMeasuredIteration: lastMeasured.iteration,
        measuredElapsedMs,
        throughputOpsPerSecond: measured.length / (measuredElapsedMs / 1000),
      },
    };
  } finally {
    await transport.close();
    environment.state.close();
    fs.rmSync(environment.temporaryDirectory, { recursive: true, force: true });
  }
}

async function measureRecovery(config) {
  const rows = [];
  const total = config.recovery.warmupSamples + config.recovery.measuredSamples;
  let transport = createTransport("remote", config);
  await transport.start();
  for (let index = 0; index < total; index += 1) {
    const recoveryStarted = nowMilliseconds();
    const crashStarted = nowMilliseconds();
    try {
      await transport.request({ type: "crash" }, 10000);
      throw new Error("crash injection unexpectedly returned a response");
    } catch (_expected) {
      // Expected: the remote stdio provider exits before responding.
    }
    const crashDetectedMs = nowMilliseconds() - crashStarted;
    transport = createTransport("remote", config);
    const restarted = await transport.start();
    const retryStarted = nowMilliseconds();
    const result = await transport.request({
      type: "invoke",
      payloadBytes: config.recovery.payloadBytes,
      serviceDelayMs: config.recovery.serviceDelayMs,
      seed: config.randomSeed + 100000 + index,
    });
    const retryRoundTripMs = nowMilliseconds() - retryStarted;
    rows.push({
      schemaVersion: 1,
      recordType: "wan_provider_recovery",
      campaignId: config.campaignId,
      transportMode: "remote",
      iteration: index + 1,
      warmup: index < config.recovery.warmupSamples,
      crashDetectedMs,
      reconnectHandshakeMs: restarted.handshakeMs,
      retryRoundTripMs,
      remoteServiceMs: result.serviceMs,
      recoveryTotalMs: nowMilliseconds() - recoveryStarted,
      outcome: "success",
    });
  }
  await transport.close();
  return rows;
}

function summarizeRows(rows, settingReports) {
  const metrics = [
    "roundTripMs",
    "handshakeMs",
    "networkRoundTripMs",
    "remoteServiceMs",
    "transportOverheadMs",
    "authorizationMs",
    "encryptedCommitMs",
    "keyReleaseMs",
    "totalMs",
    "crashDetectedMs",
    "reconnectHandshakeMs",
    "retryRoundTripMs",
    "recoveryTotalMs",
  ];
  const groups = new Map();
  for (const row of rows.filter((item) => !item.warmup)) {
    const key = [row.recordType, row.transportMode, row.concurrency || "na"].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const output = [];
  for (const samples of groups.values()) {
    const first = samples[0];
    for (const metric of metrics) {
      const values = samples.map((sample) => sample[metric]).filter(Number.isFinite);
      if (values.length === 0) continue;
      output.push({
        campaignId: first.campaignId,
        recordType: first.recordType,
        transportMode: first.transportMode,
        concurrency: first.concurrency || null,
        metric,
        ...summarize(values),
      });
    }
  }
  for (const report of settingReports) {
    output.push({
      campaignId: report.campaignId,
      recordType: "wan_protocol_sample",
      transportMode: report.transportMode,
      concurrency: report.concurrency,
      metric: "throughputOpsPerSecond",
      count: report.measuredSamples,
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

function metric(summary, mode, concurrency, name) {
  return summary.find(
    (row) =>
      row.recordType === "wan_protocol_sample" &&
      row.transportMode === mode &&
      row.concurrency === concurrency &&
      row.metric === name
  );
}

function renderSvg(summary, concurrencyLevels) {
  const width = 900;
  const height = 430;
  const margin = { left: 80, right: 30, top: 45, bottom: 70 };
  const chartHeight = height - margin.top - margin.bottom;
  const values = concurrencyLevels.flatMap((concurrency) => [
    metric(summary, "local", concurrency, "totalMs").mean,
    metric(summary, "remote", concurrency, "totalMs").mean,
  ]);
  const maximum = Math.max(...values) * 1.15;
  const groupWidth = (width - margin.left - margin.right) / concurrencyLevels.length;
  const bars = [];
  concurrencyLevels.forEach((concurrency, index) => {
    ["local", "remote"].forEach((mode, modeIndex) => {
      const value = metric(summary, mode, concurrency, "totalMs").mean;
      const barWidth = groupWidth * 0.3;
      const x = margin.left + index * groupWidth + groupWidth * 0.16 + modeIndex * barWidth;
      const barHeight = (value / maximum) * chartHeight;
      const y = margin.top + chartHeight - barHeight;
      const color = mode === "local" ? "#4c78a8" : "#e45756";
      bars.push(`<rect x="${x}" y="${y}" width="${barWidth - 4}" height="${barHeight}" fill="${color}"/>`);
      bars.push(`<text x="${x + (barWidth - 4) / 2}" y="${y - 6}" text-anchor="middle" font-size="12">${value.toFixed(1)}</text>`);
    });
    bars.push(`<text x="${margin.left + index * groupWidth + groupWidth / 2}" y="${height - 35}" text-anchor="middle" font-size="14">c=${concurrency}</text>`);
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="white"/>
  <text x="${width / 2}" y="25" text-anchor="middle" font-size="18" font-family="sans-serif">Protocol latency: same-host vs Northwest鈥揃eijing WAN</text>
  <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + chartHeight}" stroke="#333"/>
  <line x1="${margin.left}" y1="${margin.top + chartHeight}" x2="${width - margin.right}" y2="${margin.top + chartHeight}" stroke="#333"/>
  <text x="20" y="${margin.top + chartHeight / 2}" transform="rotate(-90 20 ${margin.top + chartHeight / 2})" text-anchor="middle" font-size="14">Mean end-to-end latency (ms)</text>
  ${bars.join("\n  ")}
  <rect x="${width - 210}" y="40" width="14" height="14" fill="#4c78a8"/><text x="${width - 190}" y="52" font-size="13">Same host</text>
  <rect x="${width - 110}" y="40" width="14" height="14" fill="#e45756"/><text x="${width - 90}" y="52" font-size="13">Real WAN</text>
</svg>\n`;
}

function renderReport(config, summary, rows) {
  const lines = [
    "# Phase E Real-WAN Results",
    "",
    `- Coordinator region: ${config.regions.coordinator}`,
    `- Provider region: ${config.regions.provider}`,
    "- Transport: one persistent, encrypted SSH stdio session per setting",
    "- Provider role: isolated deterministic service endpoint; no wallet or API key",
    "- Timing: coordinator monotonic clock for round trips and end-to-end latency",
    "",
    "## Protocol results",
    "",
    "| Concurrency | Same-host mean/P95 (ms) | Real-WAN mean/P95 (ms) | Same-host ops/s | Real-WAN ops/s |",
    "|---:|---:|---:|---:|---:|",
  ];
  for (const concurrency of config.protocol.concurrencyLevels) {
    const local = metric(summary, "local", concurrency, "totalMs");
    const remote = metric(summary, "remote", concurrency, "totalMs");
    const localThroughput = metric(summary, "local", concurrency, "throughputOpsPerSecond");
    const remoteThroughput = metric(summary, "remote", concurrency, "throughputOpsPerSecond");
    lines.push(
      `| ${concurrency} | ${local.mean.toFixed(3)} / ${local.p95.toFixed(3)} | ${remote.mean.toFixed(3)} / ${remote.p95.toFixed(3)} | ${localThroughput.mean.toFixed(3)} | ${remoteThroughput.mean.toFixed(3)} |`
    );
  }
  const localRtt = summary.find((row) => row.recordType === "transport_round_trip" && row.transportMode === "local");
  const remoteRtt = summary.find((row) => row.recordType === "transport_round_trip" && row.transportMode === "remote");
  const recovery = summary.find((row) => row.recordType === "wan_provider_recovery" && row.metric === "recoveryTotalMs");
  lines.push(
    "",
    "## Network and recovery",
    "",
    `- Persistent-session application RTT, same host: mean ${localRtt.mean.toFixed(3)} ms, P95 ${localRtt.p95.toFixed(3)} ms (n=${localRtt.count}).`,
    `- Persistent-session application RTT, real WAN: mean ${remoteRtt.mean.toFixed(3)} ms, P95 ${remoteRtt.p95.toFixed(3)} ms (n=${remoteRtt.count}).`,
    `- Provider crash/reconnect/retry: mean ${recovery.mean.toFixed(3)} ms, P95 ${recovery.p95.toFixed(3)} ms (n=${recovery.count}), all successful.`,
    "",
    "## Boundaries",
    "",
    "This campaign measures a real cross-region gateway-to-service path. It does not claim independent administrative control of the provider, one-way latency from unsynchronised clocks, production Internet representativeness, or additional real-LLM calls. Public-chain finality remains reported by the separate Amoy/Sepolia campaign.",
    "",
    `Measured records: ${rows.filter((row) => !row.warmup).length}.`,
    ""
  );
  return lines.join("\n");
}

async function main() {
  if (process.env.ALLOW_REAL_WAN_EXPERIMENT !== "1") {
    throw new Error("set ALLOW_REAL_WAN_EXPERIMENT=1 after explicit authorization");
  }
  const configPath = path.resolve(process.argv[2] || DEFAULT_CONFIG_PATH);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const outputDirectory = path.resolve(
    process.env.EXPERIMENT_OUTPUT ||
      path.join(PROJECT_ROOT, "experiments/v2/results", config.campaignId)
  );
  fs.mkdirSync(path.join(outputDirectory, "figures"), { recursive: true });

  const rawRows = [];
  const settingReports = [];
  const providerHellos = {};
  for (const mode of ["local", "remote"]) {
    process.stdout.write(`RUN ${mode} transport baseline\n`);
    const roundTrips = await measureRoundTrips(config, mode);
    rawRows.push(...roundTrips.rows);
    providerHellos[`${mode}RoundTrip`] = roundTrips.providerHello;
    const handshakes = await measureHandshakes(config, mode);
    rawRows.push(...handshakes.rows);
    providerHellos[`${mode}Handshake`] = handshakes.providerHello;
  }
  for (const mode of ["local", "remote"]) {
    for (const concurrency of config.protocol.concurrencyLevels) {
      process.stdout.write(`RUN ${mode} protocol concurrency=${concurrency}\n`);
      const result = await executeProtocolSetting(config, mode, concurrency);
      rawRows.push(...result.rows);
      settingReports.push(result.report);
      providerHellos[`${mode}ProtocolC${concurrency}`] = result.providerHello;
    }
  }
  process.stdout.write("RUN remote provider crash recovery\n");
  rawRows.push(...(await measureRecovery(config)));

  const summary = summarizeRows(rawRows, settingReports);
  const ping = spawnSync("ping", ["-c", "20", config.remote.host], {
    encoding: "utf8",
    timeout: 120000,
  });
  const networkBaseline = [
    `command: ping -c 20 ${config.remote.host}`,
    `exitCode: ${ping.status}`,
    ping.stdout || "",
    ping.stderr || "",
  ].join("\n");
  const report = renderReport(config, summary, rawRows);
  const svg = renderSvg(summary, config.protocol.concurrencyLevels);
  writeJsonLines(path.join(outputDirectory, "wan_raw.jsonl"), rawRows);
  writeCsv(path.join(outputDirectory, "wan_summary.csv"), summary);
  writeJson(path.join(outputDirectory, "wan_summary.json"), summary);
  fs.writeFileSync(path.join(outputDirectory, "network_baseline.txt"), networkBaseline);
  fs.writeFileSync(path.join(outputDirectory, "WAN_RESULTS_REPORT.md"), report);
  fs.writeFileSync(path.join(outputDirectory, "figures/wan_protocol_latency.svg"), svg);

  const files = {};
  for (const name of [
    "wan_raw.jsonl",
    "wan_summary.csv",
    "wan_summary.json",
    "network_baseline.txt",
    "WAN_RESULTS_REPORT.md",
    "figures/wan_protocol_latency.svg",
  ]) {
    const filePath = path.join(outputDirectory, name);
    files[name] = { sha256: sha256File(filePath), sizeBytes: fs.statSync(filePath).size };
  }
  const manifest = {
    schemaVersion: 1,
    campaignId: config.campaignId,
    campaignClass: config.campaignClass,
    generatedAt: new Date().toISOString(),
    configPath: path.relative(PROJECT_ROOT, configPath),
    configSha256: sha256File(configPath),
    authorizationGate: "ALLOW_REAL_WAN_EXPERIMENT=1",
    regions: config.regions,
    transport: "persistent encrypted SSH stdio",
    git: {
      commit: commandOutput("git", ["rev-parse", "HEAD"], PROJECT_ROOT),
      branch: commandOutput("git", ["branch", "--show-current"], PROJECT_ROOT),
      trackedStatus:
        commandOutput("git", ["status", "--porcelain", "--untracked-files=no"], PROJECT_ROOT) || "",
    },
    coordinator: {
      platform: os.platform(),
      release: os.release(),
      architecture: os.arch(),
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      runtime: process.version,
    },
    providerHellos,
    samples: {
      total: rawRows.length,
      measured: rawRows.filter((row) => !row.warmup).length,
      warmup: rawRows.filter((row) => row.warmup).length,
    },
    secrets: {
      sshPrivateKeyStoredInResults: false,
      walletKeyStoredOnProvider: false,
      llmApiKeyStoredOnProvider: false,
    },
    files,
    evidenceFiles: Object.entries(files).map(([name, metadata]) => ({
      path: path.posix.join(config.campaignId, name),
      sizeBytes: metadata.sizeBytes,
      sha256: metadata.sha256,
    })),
  };
  writeJson(path.join(outputDirectory, "wan_manifest.json"), manifest);
  console.log(`PASS real-WAN campaign: ${manifest.samples.measured} measured, ${manifest.samples.warmup} warm-up`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

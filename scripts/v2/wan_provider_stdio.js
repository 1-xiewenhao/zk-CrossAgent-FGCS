const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const readline = require("readline");

const SCHEMA_VERSION = 1;
const startedAt = new Date().toISOString();
const scriptSha256 = crypto
  .createHash("sha256")
  .update(fs.readFileSync(__filename))
  .digest("hex");

function nowMilliseconds() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function writeResponse(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function handle(message) {
  const requestId = String(message.requestId || "");
  if (!requestId) throw new Error("requestId is required");

  if (message.type === "hello") {
    return {
      schemaVersion: SCHEMA_VERSION,
      type: "hello",
      requestId,
      role: "isolated-wan-provider",
      startedAt,
      runtime: process.version,
      scriptSha256,
      host: {
        platform: os.platform(),
        release: os.release(),
        architecture: os.arch(),
        logicalCpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
      },
    };
  }

  if (message.type === "ping") {
    return {
      schemaVersion: SCHEMA_VERSION,
      type: "pong",
      requestId,
    };
  }

  if (message.type === "crash") {
    process.exitCode = 71;
    setImmediate(() => process.exit(71));
    return null;
  }

  if (message.type === "shutdown") {
    process.exitCode = 0;
    setImmediate(() => process.exit(0));
    return {
      schemaVersion: SCHEMA_VERSION,
      type: "shutdown",
      requestId,
    };
  }

  if (message.type !== "invoke") throw new Error("unsupported message type");
  const payloadBytes = Number(message.payloadBytes);
  const serviceDelayMs = Number(message.serviceDelayMs || 0);
  const seed = Number(message.seed || 0);
  if (!Number.isInteger(payloadBytes) || payloadBytes < 1 || payloadBytes > 1048576) {
    throw new Error("payloadBytes must be an integer in [1, 1048576]");
  }
  if (!Number.isFinite(serviceDelayMs) || serviceDelayMs < 0 || serviceDelayMs > 60000) {
    throw new Error("serviceDelayMs must be in [0, 60000]");
  }

  const serviceStarted = nowMilliseconds();
  await sleep(serviceDelayMs);
  const payload = Buffer.alloc(payloadBytes, seed % 251);
  const responseSha256 = crypto.createHash("sha256").update(payload).digest("hex");
  const serviceMs = nowMilliseconds() - serviceStarted;
  return {
    schemaVersion: SCHEMA_VERSION,
    type: "result",
    requestId,
    payloadBase64: payload.toString("base64"),
    payloadBytes,
    responseSha256,
    serviceMs,
  };
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    writeResponse({ schemaVersion: SCHEMA_VERSION, type: "error", error: error.message });
    return;
  }
  Promise.resolve(handle(message))
    .then((response) => {
      if (response) writeResponse(response);
    })
    .catch((error) => {
      writeResponse({
        schemaVersion: SCHEMA_VERSION,
        type: "error",
        requestId: String(message.requestId || ""),
        error: error.message,
      });
    });
});

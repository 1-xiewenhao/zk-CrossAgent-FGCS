const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function nowMilliseconds() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function percentile(sorted, value) {
  if (sorted.length === 0) return null;
  const rank = (value / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function summarize(values) {
  const numeric = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (numeric.length === 0) {
    return { count: 0, mean: null, stddev: null, ci95: null, p50: null,
      p95: null, p99: null, min: null, max: null };
  }
  const mean = numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
  const variance = numeric.length > 1
    ? numeric.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      (numeric.length - 1)
    : 0;
  const stddev = Math.sqrt(variance);
  const margin = 1.96 * stddev / Math.sqrt(numeric.length);
  return {
    count: numeric.length,
    mean,
    stddev,
    ci95: [mean - margin, mean + margin],
    p50: percentile(numeric, 50),
    p95: percentile(numeric, 95),
    p99: percentile(numeric, 99),
    min: numeric[0],
    max: numeric[numeric.length - 1],
  };
}

function seededRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function commandOutput(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonLines(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(","));
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}

module.exports = {
  commandOutput,
  nowMilliseconds,
  seededRandom,
  sha256File,
  sleep,
  summarize,
  writeCsv,
  writeJson,
  writeJsonLines,
};

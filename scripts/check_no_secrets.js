const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const excludedDirectories = new Set([
  ".git",
  "artifacts",
  "cache",
  "node_modules",
  "runtime",
  "tmp",
]);
const scannedExtensions = new Set([
  ".circom",
  ".example",
  ".js",
  ".json",
  ".md",
  ".sol",
  ".yml",
  ".yaml",
]);
const literalPrivateKey = /0x[0-9a-fA-F]{64}/g;
const privateKeyAssignment =
  /["']?(?:[A-Za-z0-9]+_)*(?:private[_-]?key|secret[_-]?key)["']?\s*[:=]\s*["']?(0x[0-9a-fA-F]{64})/gi;
const findings = [];

function recordFinding(fullPath, content, match) {
  const offset = match.index ?? content.indexOf(match[0]);
  const value = match[1] || match[0];
  findings.push({
    file: path.relative(root, fullPath),
    line: content.slice(0, offset).split("\n").length,
    preview: `${value.slice(0, 10)}...${value.slice(-6)}`,
  });
}

function scanDirectory(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;

    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;

    const extension = path.extname(entry.name);
    if (!scannedExtensions.has(extension) && entry.name !== ".gitignore") {
      continue;
    }

    const content = fs.readFileSync(fullPath, "utf8");
    for (const match of content.matchAll(privateKeyAssignment)) {
      recordFinding(fullPath, content, match);
    }

    // Public experiment artifacts intentionally contain 32-byte transaction
    // hashes, roots, domains, and proof fields. These values are
    // indistinguishable from a private key by length alone, so retain the
    // broad literal check everywhere except the frozen public-results tree.
    // The contextual assignment check above still scans that tree.
    const relativePath = path.relative(root, fullPath).split(path.sep).join("/");
    if (!relativePath.startsWith("experiments/v2/results/")) {
      for (const match of content.matchAll(literalPrivateKey)) {
        recordFinding(fullPath, content, match);
      }
    }
  }
}

scanDirectory(root);

if (findings.length > 0) {
  console.error("Potential literal private keys found:");
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line}: ${finding.preview}`);
  }
  process.exit(1);
}

console.log("Secret scan passed: no literal 32-byte hex private keys found.");

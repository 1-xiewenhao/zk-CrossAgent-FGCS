const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");

function commandOutput(command, args) {
  const executable =
    process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function packageVersion(packageName) {
  try {
    return require(`${packageName}/package.json`).version;
  } catch (_) {
    try {
      const packageJsonPath = path.join(
        root,
        "node_modules",
        ...packageName.split("/"),
        "package.json"
      );
      return JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).version;
    } catch (_) {
      return null;
    }
  }
}

function sha256(relativePath) {
  const data = fs.readFileSync(path.join(root, relativePath));
  return crypto.createHash("sha256").update(data).digest("hex");
}

const cpuModels = [...new Set(os.cpus().map((cpu) => cpu.model))];
const snapshot = {
  capturedAt: new Date().toISOString(),
  git: {
    commit: commandOutput("git", ["rev-parse", "HEAD"]),
    branch: commandOutput("git", ["branch", "--show-current"]),
    statusPorcelain: commandOutput("git", ["status", "--porcelain"]) || "",
  },
  host: {
    platform: os.platform(),
    release: os.release(),
    architecture: os.arch(),
    cpuModels,
    logicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    gpu:
      commandOutput("nvidia-smi", [
        "--query-gpu=name,memory.total",
        "--format=csv,noheader",
      ]) || "not detected",
  },
  runtime: {
    node: process.version,
    npm: commandOutput("npm", ["--version"]),
    circom: commandOutput("circom", ["--version"]),
    hardhat: packageVersion("hardhat"),
    ethers: packageVersion("ethers"),
    openzeppelinContracts: packageVersion("@openzeppelin/contracts"),
    snarkjs: packageVersion("snarkjs"),
    circomlib: packageVersion("circomlib"),
    solidityConfigured: "0.8.28",
    evmVersionConfigured: "cancun",
  },
  integrity: {
    packageLockSha256: sha256("package-lock.json"),
  },
};

process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "../..");
const circuitPath = path.join(
  projectRoot,
  "circuits/v2/zk_crossagent_v2.circom"
);
const buildDirectory = path.join(projectRoot, "circuits/v2/build");

fs.mkdirSync(buildDirectory, { recursive: true });
execFileSync(
  "circom",
  [
    circuitPath,
    "--r1cs",
    "--wasm",
    "--sym",
    "--O2",
    "-o",
    buildDirectory,
  ],
  { stdio: "inherit" }
);
execFileSync(
  process.execPath,
  [
    path.join(projectRoot, "node_modules/snarkjs/cli.js"),
    "r1cs",
    "info",
    path.join(buildDirectory, "zk_crossagent_v2.r1cs"),
  ],
  { stdio: "inherit" }
);

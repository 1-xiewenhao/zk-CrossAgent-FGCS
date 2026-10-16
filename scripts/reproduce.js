require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const root = path.resolve(__dirname, "..");
const mode = process.argv[2];
const configs = "experiments/v2/configs/";
const config = name => configs + "submission-" + name + "-20261015.json";
const hh = "node_modules/hardhat/internal/cli/cli.js";
const env = { ...process.env, CI: "true", HARDHAT_DISABLE_TELEMETRY_PROMPT: "true" };
// Empty optional values in the example must not override script defaults.
for (const key of ["PTAU_PATH", "EXPERIMENT_OUTPUT", "EXPERIMENT_CONFIG"]) {
  if (!env[key]) delete env[key];
}
function run(script, args = [], extra = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root, env: { ...env, ...extra }, stdio: "inherit", windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
function required(name) {
  if (!env[name]) throw new Error("Configure " + name + " in .env before this experiment");
}
function testnetConfig() {
  return process.argv[3] || config("testnet");
}
switch (mode) {
  case "bootstrap":
    run("scripts/v2/compile_circuit.js");
    run("scripts/v2/setup_groth16.js");
    run("scripts/v2/prove_groth16.js");
    run(hh, ["compile"]);
    break;
  case "unit": {
    // These three test files require proof fixtures or circuit build products.
    const needsBootstrap = new Set([
      "v2_groth16_verifier.test.js", "v2_batch_registry.test.js", "v2_deadline_settlement.test.js",
    ]);
    const tests = fs.readdirSync(path.join(root, "test"))
      .filter(n => n.endsWith(".test.js") && !needsBootstrap.has(n))
      .sort().map(n => "test/" + n);
    run(hh, ["test", ...tests]);
    break;
  }
  case "formal": run("scripts/v2/run_formal_checks.js"); break;
  case "circuit":
    run("scripts/v2/test_circuit_witness.js");
    run("scripts/v2/test_authorization_circuit.js", [], { JNCA_CIRCUIT_OUTPUT: "runtime/circuit-checks" });
    break;
  case "local":
    run("scripts/v2/benchmark_protocol_v2.js", [config("local")]);
    run("scripts/v2/benchmark_zk_v2.js", [config("local")]);
    run("scripts/v2/benchmark_fault_recovery_v2.js", [config("fault-gas")]);
    run(hh, ["run", "scripts/v2/benchmark_local_gas_v2.js", "--network", "hardhat"],
      { EXPERIMENT_CONFIG: config("fault-gas") });
    run("scripts/v2/analyze_gas_baselines_v2.js", ["reproduction-fault-gas"]);
    break;
  case "llm": run("scripts/v2/benchmark_real_llm_v2.js", [process.argv[3] || config("llm")]); break;
  case "wan": {
    required("WAN_SSH_KEY_PATH"); required("WAN_KNOWN_HOSTS_PATH");
    const cp = process.argv[3] || config("wan");
    const c = JSON.parse(fs.readFileSync(path.resolve(root, cp), "utf8"));
    if (JSON.stringify(c.remote).includes("YOUR_") || JSON.stringify(c.remote).includes("/ABSOLUTE/")) {
      throw new Error("Create a *.local.json WAN configuration with your own two-host deployment");
    }
    run("scripts/wan/cache-host.js");
    const preload = path.join(root, "scripts/wan/static-host-metadata.cjs");
    run("scripts/v2/benchmark_wan_v2.js", [cp], {
      NODE_OPTIONS: [env.NODE_OPTIONS || "", "--require", JSON.stringify(preload)].join(" ").trim(),
    });
    break;
  }
  case "testnet-plan":
    run("scripts/v2/deploy_testnet_v2.js", [testnetConfig()], { ALLOW_TESTNET_DEPLOYMENT: "0" });
    break;
  case "testnet-deploy":
    if (env.ALLOW_TESTNET_DEPLOYMENT !== "1") throw new Error("Set ALLOW_TESTNET_DEPLOYMENT=1 to deploy");
    run("scripts/v2/deploy_testnet_v2.js", [testnetConfig()]);
    break;
  case "testnet":
    run("scripts/v2/benchmark_testnet_v2.js", [testnetConfig()]);
    run("scripts/v2/benchmark_withdrawal_testnet.js", [testnetConfig()]);
    break;
  default:
    console.error("Usage: node scripts/reproduce.js bootstrap|unit|formal|circuit|local|llm|wan|testnet-plan|testnet-deploy|testnet [config]");
    process.exitCode = 2;
}

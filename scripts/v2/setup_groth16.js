const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const snarkjs = require("snarkjs");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const CIRCUIT_DIRECTORY = path.join(PROJECT_ROOT, "circuits/v2");
const BUILD_DIRECTORY = path.join(CIRCUIT_DIRECTORY, "build");
const SETUP_DIRECTORY = path.join(CIRCUIT_DIRECTORY, "setup");
const EVIDENCE_DIRECTORY = path.join(CIRCUIT_DIRECTORY, "evidence");
const GENERATED_CONTRACT_DIRECTORY = path.join(
  PROJECT_ROOT,
  "contracts/v2/generated"
);

const R1CS_PATH = path.join(BUILD_DIRECTORY, "zk_crossagent_v2.r1cs");
const WASM_PATH = path.join(
  BUILD_DIRECTORY,
  "zk_crossagent_v2_js/zk_crossagent_v2.wasm"
);
const PTAU_PATH =
  process.env.PTAU_PATH ||
  path.join(SETUP_DIRECTORY, "powersOfTau28_hez_final_19.ptau");
const INITIAL_ZKEY_PATH = path.join(
  SETUP_DIRECTORY,
  "zk_crossagent_v2_0000.zkey"
);
const CONTRIBUTED_ZKEY_PATH = path.join(
  SETUP_DIRECTORY,
  "zk_crossagent_v2_0001.zkey"
);
const FINAL_ZKEY_PATH = path.join(
  SETUP_DIRECTORY,
  "zk_crossagent_v2_final.zkey"
);
const BEACON_PATH = path.join(SETUP_DIRECTORY, "phase2_beacon.txt");
const VERIFICATION_KEY_PATH = path.join(
  EVIDENCE_DIRECTORY,
  "verification_key.json"
);
const VERIFIER_PATH = path.join(
  GENERATED_CONTRACT_DIRECTORY,
  "ZkCrossAgentBatchVerifierV2.sol"
);
const SETUP_METADATA_PATH = path.join(
  EVIDENCE_DIRECTORY,
  "setup_metadata.json"
);

const PTAU_SOURCE =
  "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_19.ptau";
const EXPECTED_PTAU_BLAKE2B512 =
  "bca9d8b04242f175189872c42ceaa21e2951e0f0f272a0cc54fc37193ff6648600eaf1c555c70cdedfaf9fb74927de7aa1d33dc1e2a7f1a50619484989da0887";

const logger = {
  debug: (message) => console.log(message),
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

function ensureFile(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`missing file: ${filePath}`);
}

function digestFile(filePath, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function describeFile(filePath, includeBlake2b = false) {
  const description = {
    path: path.relative(PROJECT_ROOT, filePath).replaceAll("\\", "/"),
    sizeBytes: fs.statSync(filePath).size,
    sha256: await digestFile(filePath, "sha256"),
  };
  if (includeBlake2b) {
    description.blake2b512 = await digestFile(filePath, "blake2b512");
  }
  return description;
}

async function main() {
  for (const directory of [
    SETUP_DIRECTORY,
    EVIDENCE_DIRECTORY,
    GENERATED_CONTRACT_DIRECTORY,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  ensureFile(R1CS_PATH);
  ensureFile(WASM_PATH);
  ensureFile(PTAU_PATH);

  const actualPtauHash = await digestFile(PTAU_PATH, "blake2b512");
  if (actualPtauHash !== EXPECTED_PTAU_BLAKE2B512) {
    throw new Error(
      `ptau BLAKE2b-512 mismatch: expected ${EXPECTED_PTAU_BLAKE2B512}, received ${actualPtauHash}`
    );
  }
  console.log("PASS published ptau BLAKE2b-512");
  if (!(await snarkjs.powersOfTau.verify(PTAU_PATH, logger))) {
    throw new Error("Powers of Tau transcript verification failed");
  }
  console.log("PASS Powers of Tau transcript");

  if (!fs.existsSync(FINAL_ZKEY_PATH)) {
    let contributedKeyIsValid = false;
    if (fs.existsSync(CONTRIBUTED_ZKEY_PATH)) {
      contributedKeyIsValid = await snarkjs.zKey.verifyFromR1cs(
        R1CS_PATH,
        PTAU_PATH,
        CONTRIBUTED_ZKEY_PATH,
        logger
      );
    }
    if (!contributedKeyIsValid) {
      await snarkjs.zKey.newZKey(
        R1CS_PATH,
        PTAU_PATH,
        INITIAL_ZKEY_PATH,
        logger
      );
      const privateContributionEntropy = crypto
        .randomBytes(64)
        .toString("hex");
      await snarkjs.zKey.contribute(
        INITIAL_ZKEY_PATH,
        CONTRIBUTED_ZKEY_PATH,
        "zk-CrossAgent Phase C.5 prototype contributor",
        privateContributionEntropy,
        logger
      );
    }

    const beacon = fs.existsSync(BEACON_PATH)
      ? fs.readFileSync(BEACON_PATH, "utf8").trim()
      : crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(BEACON_PATH, `${beacon}\n`, { mode: 0o600 });
    await snarkjs.zKey.beacon(
      CONTRIBUTED_ZKEY_PATH,
      FINAL_ZKEY_PATH,
      "zk-CrossAgent Phase C.5 final beacon",
      beacon,
      10,
      logger
    );
  }
  if (
    !(await snarkjs.zKey.verifyFromR1cs(
      R1CS_PATH,
      PTAU_PATH,
      FINAL_ZKEY_PATH,
      logger
    ))
  ) {
    throw new Error("final zkey verification failed");
  }
  console.log("PASS circuit-specific final zkey");

  const verificationKey = await snarkjs.zKey.exportVerificationKey(
    FINAL_ZKEY_PATH,
    logger
  );
  fs.writeFileSync(
    VERIFICATION_KEY_PATH,
    `${JSON.stringify(verificationKey, null, 2)}\n`
  );

  const snarkjsDirectory = path.resolve(
    path.dirname(require.resolve("snarkjs")),
    ".."
  );
  const snarkjsPackage = JSON.parse(
    fs.readFileSync(path.join(snarkjsDirectory, "package.json"), "utf8")
  );
  const templates = {
    groth16: fs.readFileSync(
      path.join(snarkjsDirectory, "templates/verifier_groth16.sol.ejs"),
      "utf8"
    ),
  };
  const generatedVerifier = await snarkjs.zKey.exportSolidityVerifier(
    FINAL_ZKEY_PATH,
    templates,
    logger
  );
  const namedVerifier = generatedVerifier.replace(
    "contract Groth16Verifier",
    "contract ZkCrossAgentBatchVerifierV2"
  );
  fs.writeFileSync(VERIFIER_PATH, namedVerifier);

  const circomVersion = execFileSync("circom", ["--version"], {
    encoding: "utf8",
  }).trim();
  const metadata = {
    protocolVersion: 2,
    generatedAt: new Date().toISOString(),
    curve: "bn128",
    provingSystem: "groth16",
    circuitCapacity: 16,
    r1cs: {
      optimization: "O2",
      wires: 177433,
      constraints: 179000,
      privateInputs: 800,
      publicInputs: 5,
      outputs: 1,
    },
    tools: {
      node: process.version,
      snarkjs: snarkjsPackage.version,
      circom: circomVersion,
    },
    phase1: {
      power: 19,
      maximumConstraints: 524288,
      minimumSufficientPowerForCurrentO2R1cs: 18,
      source: PTAU_SOURCE,
      publishedBlake2b512: EXPECTED_PTAU_BLAKE2B512,
      transcriptVerified: true,
    },
    phase2: {
      model:
        "one private prototype contribution followed by a recorded random beacon; not a multi-party production ceremony",
      contributionName: "zk-CrossAgent Phase C.5 prototype contributor",
      beaconName: "zk-CrossAgent Phase C.5 final beacon",
      beacon: fs.readFileSync(BEACON_PATH, "utf8").trim(),
      beaconIterationsExponent: 10,
      finalZkeyVerifiedAgainstR1csAndPtau: true,
    },
    files: {
      circuitSource: await describeFile(
        path.join(CIRCUIT_DIRECTORY, "zk_crossagent_v2.circom")
      ),
      r1cs: await describeFile(R1CS_PATH),
      wasm: await describeFile(WASM_PATH),
      ptau: await describeFile(PTAU_PATH, true),
      finalZkey: await describeFile(FINAL_ZKEY_PATH),
      verificationKey: await describeFile(VERIFICATION_KEY_PATH),
      solidityVerifier: await describeFile(VERIFIER_PATH),
    },
  };
  fs.writeFileSync(
    SETUP_METADATA_PATH,
    `${JSON.stringify(metadata, null, 2)}\n`
  );
  console.log(`PASS wrote ${path.relative(PROJECT_ROOT, SETUP_METADATA_PATH)}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

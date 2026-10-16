const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const snarkjs = require("snarkjs");
const { buildPoseidon } = require("circomlibjs");
const { buildCircuitInput } = require("../../lib/protocol-v2");
const {
  CIRCUIT_FIXTURE_DOMAIN_HASH,
  createCircuitFixture,
} = require("../../lib/v2/circuit-fixture");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const BUILD_DIRECTORY = path.join(PROJECT_ROOT, "circuits/v2/build");
const SETUP_DIRECTORY = path.join(PROJECT_ROOT, "circuits/v2/setup");
const EVIDENCE_DIRECTORY = path.join(PROJECT_ROOT, "circuits/v2/evidence");
const R1CS_PATH = path.join(BUILD_DIRECTORY, "zk_crossagent_v2.r1cs");
const WASM_PATH = path.join(
  BUILD_DIRECTORY,
  "zk_crossagent_v2_js/zk_crossagent_v2.wasm"
);
const ZKEY_PATH = path.join(
  SETUP_DIRECTORY,
  "zk_crossagent_v2_final.zkey"
);
const WITNESS_PATH = path.join(SETUP_DIRECTORY, "valid_fixture.wtns");
const VERIFICATION_KEY_PATH = path.join(
  EVIDENCE_DIRECTORY,
  "verification_key.json"
);
const INPUT_PATH = path.join(EVIDENCE_DIRECTORY, "valid_input.json");
const PROOF_PATH = path.join(EVIDENCE_DIRECTORY, "proof.json");
const PUBLIC_PATH = path.join(EVIDENCE_DIRECTORY, "public.json");
const CALLDATA_PATH = path.join(EVIDENCE_DIRECTORY, "solidity_calldata.txt");
const PROOF_METADATA_PATH = path.join(
  EVIDENCE_DIRECTORY,
  "proof_metadata.json"
);

function digestFile(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

async function main() {
  for (const filePath of [
    R1CS_PATH,
    WASM_PATH,
    ZKEY_PATH,
    VERIFICATION_KEY_PATH,
  ]) {
    if (!fs.existsSync(filePath)) throw new Error(`missing file: ${filePath}`);
  }
  fs.mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });

  const poseidon = await buildPoseidon();
  const fixture = createCircuitFixture(poseidon);
  const { input, expectedBatchRoot } = buildCircuitInput(
    poseidon,
    [fixture],
    {
      settlementDomainHash: CIRCUIT_FIXTURE_DOMAIN_HASH,
      batchEpoch: 1,
    }
  );
  fs.writeFileSync(INPUT_PATH, `${JSON.stringify(input, null, 2)}\n`);
  await snarkjs.wtns.calculate(input, WASM_PATH, WITNESS_PATH, {
    singleThread: true,
  });
  if (!(await snarkjs.wtns.check(R1CS_PATH, WITNESS_PATH))) {
    throw new Error("generated witness does not satisfy the R1CS");
  }
  console.log("PASS witness satisfies R1CS");

  const startedAt = process.hrtime.bigint();
  const { proof, publicSignals } = await snarkjs.groth16.prove(
    ZKEY_PATH,
    WITNESS_PATH
  );
  const provingMilliseconds =
    Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  const verificationKey = JSON.parse(
    fs.readFileSync(VERIFICATION_KEY_PATH, "utf8")
  );
  if (
    !(await snarkjs.groth16.verify(
      verificationKey,
      publicSignals,
      proof
    ))
  ) {
    throw new Error("Groth16 proof verification failed");
  }
  if (BigInt(publicSignals[0]) !== expectedBatchRoot) {
    throw new Error("public batch root differs from the fixture Merkle root");
  }
  console.log("PASS Groth16 proof verifies");

  fs.writeFileSync(PROOF_PATH, `${JSON.stringify(proof, null, 2)}\n`);
  fs.writeFileSync(PUBLIC_PATH, `${JSON.stringify(publicSignals, null, 2)}\n`);
  const calldata = await snarkjs.groth16.exportSolidityCallData(
    proof,
    publicSignals
  );
  fs.writeFileSync(CALLDATA_PATH, `${calldata}\n`);
  const metadata = {
    protocolVersion: 2,
    generatedAt: new Date().toISOString(),
    fixture: "deterministic single-real-receipt batch padded to 16",
    publicSignalOrder: [
      "batchRoot",
      "protocolVersion",
      "settlementDomainHashHi",
      "settlementDomainHashLo",
      "batchEpoch",
      "realCount",
    ],
    publicSignals,
    expectedBatchRoot: expectedBatchRoot.toString(),
    provingMilliseconds,
    verifiedOffchain: true,
    files: {
      inputSha256: digestFile(INPUT_PATH),
      proofSha256: digestFile(PROOF_PATH),
      publicSha256: digestFile(PUBLIC_PATH),
      calldataSha256: digestFile(CALLDATA_PATH),
      finalZkeySha256: digestFile(ZKEY_PATH),
      verificationKeySha256: digestFile(VERIFICATION_KEY_PATH),
    },
  };
  fs.writeFileSync(
    PROOF_METADATA_PATH,
    `${JSON.stringify(metadata, null, 2)}\n`
  );
  console.log(`PASS proof generated in ${provingMilliseconds.toFixed(1)} ms`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

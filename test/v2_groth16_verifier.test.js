const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const EVIDENCE_DIRECTORY = path.resolve(
  __dirname,
  "../circuits/v2/evidence"
);
const CALLDATA_PATH = path.join(
  EVIDENCE_DIRECTORY,
  "solidity_calldata.txt"
);
const PUBLIC_PATH = path.join(EVIDENCE_DIRECTORY, "public.json");

describe("ZkCrossAgentBatchVerifierV2", function () {
  it("accepts the frozen proof and rejects a changed public batch root", async function () {
    assert(fs.existsSync(CALLDATA_PATH), "missing frozen Solidity calldata");
    const calldata = JSON.parse(
      `[${fs.readFileSync(CALLDATA_PATH, "utf8").trim()}]`
    );
    const publicSignals = JSON.parse(fs.readFileSync(PUBLIC_PATH, "utf8"));
    assert.deepStrictEqual(
      calldata[3].map((value) => BigInt(value)),
      publicSignals.map((value) => BigInt(value))
    );

    const Verifier = await ethers.getContractFactory(
      "ZkCrossAgentBatchVerifierV2"
    );
    const verifier = await Verifier.deploy();
    await verifier.deployed();
    assert.strictEqual(await verifier.verifyProof(...calldata), true);

    const modifiedSignals = [...calldata[3]];
    modifiedSignals[0] = (BigInt(modifiedSignals[0]) + 1n).toString();
    assert.strictEqual(
      await verifier.verifyProof(
        calldata[0],
        calldata[1],
        calldata[2],
        modifiedSignals
      ),
      false
    );
  });
});

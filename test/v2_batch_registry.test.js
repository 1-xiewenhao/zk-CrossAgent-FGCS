const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

function frozenCalldata() {
  const filePath = path.join(
    __dirname,
    "../circuits/v2/evidence/solidity_calldata.txt"
  );
  return JSON.parse(`[${fs.readFileSync(filePath, "utf8").trim()}]`);
}

async function expectRevert(promise, message) {
  try {
    await promise;
    assert.fail(`expected revert containing: ${message}`);
  } catch (error) {
    assert(error.message.includes(message), error.message);
  }
}

describe("BatchRegistryV2", function () {
  this.timeout(120000);

  it("registers only the frozen domain-bound Groth16 batch once", async function () {
    const [, settlementContract] = await ethers.getSigners();
    const calldata = frozenCalldata();
    const publicSignals = calldata[3].map((value) => ethers.BigNumber.from(value));
    const domain = ethers.utils.hexZeroPad(
      publicSignals[2].shl(128).or(publicSignals[3]).toHexString(),
      32
    );
    const Verifier = await ethers.getContractFactory(
      "ZkCrossAgentBatchVerifierV2"
    );
    const verifier = await Verifier.deploy();
    await verifier.deployed();
    const Registry = await ethers.getContractFactory("BatchRegistryV2");
    const registry = await Registry.deploy(
      verifier.address,
      domain,
      11155111,
      settlementContract.address
    );
    await registry.deployed();

    const root = publicSignals[0];
    const epoch = publicSignals[4].toNumber();
    const realCount = publicSignals[5].toNumber();
    const batchKey = await registry.computeBatchKey(epoch, root);
    await (
      await registry.registerBatchProof(
        epoch,
        realCount,
        root,
        calldata[0],
        calldata[1],
        calldata[2]
      )
    ).wait();
    const record = await registry.getRegisteredBatch(batchKey);
    assert.strictEqual(record.exists, true);
    assert.strictEqual(Number(record.realCount), realCount);
    assert(record.batchRoot.eq(root));

    await expectRevert(
      registry.registerBatchProof(
        epoch,
        realCount,
        root,
        calldata[0],
        calldata[1],
        calldata[2]
      ),
      "RegistryV2: duplicate batch"
    );
    await expectRevert(
      registry.registerBatchProof(
        epoch + 1,
        realCount,
        root,
        calldata[0],
        calldata[1],
        calldata[2]
      ),
      "RegistryV2: invalid proof"
    );
    await expectRevert(
      registry.registerBatchProof(
        epoch + 2,
        realCount + 1,
        root,
        calldata[0],
        calldata[1],
        calldata[2]
      ),
      "RegistryV2: invalid proof"
    );
  });
});

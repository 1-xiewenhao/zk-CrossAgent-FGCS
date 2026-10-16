const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { fork } = require("child_process");
const { ethers } = require("ethers");
const {
  PersistentProtocolState,
} = require("../lib/v2/persistent-state");

function hash(label) {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(label));
}

describe("PersistentProtocolState v2 crash injection", function () {
  let temporaryDirectory;
  let databasePath;
  let state;
  const timestamp = 1_900_000_000;
  const rootCommitment = "777";
  const payer = "0x1000000000000000000000000000000000000001";
  const buyer = "0x2000000000000000000000000000000000000002";
  const callId = hash("phase-d-crash-call");

  beforeEach(function () {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "zk-crossagent-crash-")
    );
    databasePath = path.join(temporaryDirectory, "protocol.sqlite");
    state = new PersistentProtocolState(databasePath, {
      clock: () => timestamp,
    });
    state.registerRoot({
      rootCommitment,
      payer,
      buyer,
      budget: 100,
      maxSubcalls: 2,
      expiry: timestamp + 3600,
    });
  });

  afterEach(function () {
    if (state?.db?.open) state.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  function reopen() {
    state = new PersistentProtocolState(databasePath, {
      clock: () => timestamp,
    });
  }

  function crashAfter(action, payload) {
    if (state?.db?.open) state.close();
    return new Promise((resolve, reject) => {
      const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
        "base64"
      );
      const worker = fork(
        path.join(__dirname, "../scripts/v2/crash_worker.js"),
        [databasePath, action, encoded],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] }
      );
      let stderr = "";
      worker.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      worker.on("error", reject);
      worker.on("exit", (code) => {
        if (code !== 91) {
          reject(
            new Error(
              `crash worker exited ${code}: ${stderr.trim()}`
            )
          );
          return;
        }
        reopen();
        resolve();
      });
    });
  }

  it("recovers every committed gateway and settlement checkpoint", async function () {
    await crashAfter("before-reserve", {});
    assert.strictEqual(state.getCall(callId), null);

    const reservation = {
      callId,
      rootCommitment,
      childIssuer: buyer,
      childNonce: 44,
      amount: 25,
      metadata: { test: "phase-d" },
    };
    await crashAfter("reserve", reservation);
    assert.strictEqual(state.getCall(callId).state, "RESERVED");
    assert.strictEqual(state.getRoot(rootCommitment).reservedAmount, 25n);
    assert.strictEqual(state.reserveCall(reservation).idempotent, true);

    await crashAfter("provider", {
      callId,
      providerPayload: {
        ciphertextHash: hash("ciphertext"),
        keyCommitment: hash("key"),
      },
      providerSignature: "0x1234",
    });
    assert.strictEqual(
      state.getCall(callId).state,
      "RESPONSE_COMMITTED"
    );

    await crashAfter("buyer", {
      callId,
      buyerSignature: "0x5678",
    });
    assert.strictEqual(state.getCall(callId).state, "BUYER_CONFIRMED");
    assert.throws(
      () => state.expireUnconfirmed(callId),
      /only unconfirmed reservations may expire/
    );

    await crashAfter("key", {
      callId,
      keyReveal: hash("revealed-key"),
      keyRevealHash: hash("revealed-key-hash"),
    });
    assert.strictEqual(state.getCall(callId).state, "KEY_RELEASED");

    await crashAfter("seal", {
      epoch: 12,
      batchRoot: 123456,
      callIds: [callId],
      metadata: { test: "phase-d" },
    });
    assert.strictEqual(state.getCall(callId).state, "BATCHED");
    assert.deepStrictEqual(state.getBatch(12).callIds, [callId]);

    await crashAfter("proved", { callId });
    assert.strictEqual(state.getCall(callId).state, "PROVED");

    await crashAfter("relayed", { callId });
    assert.strictEqual(state.getCall(callId).state, "ROOT_RELAYED");

    const transactionHash = hash("settlement-transaction");
    await crashAfter("settling", { callId, transactionHash });
    assert.strictEqual(state.getCall(callId).state, "SETTLING");
    assert.strictEqual(
      state.getCall(callId).settlementTransactionHash,
      transactionHash
    );

    await crashAfter("settled", { callId });
    assert.strictEqual(state.getCall(callId).state, "SETTLED");
    assert.strictEqual(state.markSettled(callId).idempotent, true);
    const root = state.getRoot(rootCommitment);
    assert.strictEqual(root.reservedAmount, 0n);
    assert.strictEqual(root.settledAmount, 25n);
    assert.strictEqual(root.reservedCalls, 0);
    assert.strictEqual(root.settledCalls, 1);
    assert.strictEqual(state.assertRootInvariant(rootCommitment), true);

    const transitions = state.transitions(callId);
    assert.deepStrictEqual(
      transitions.map((transition) => transition.to_state),
      [
        "RECEIVED",
        "RESERVED",
        "RESPONSE_COMMITTED",
        "BUYER_CONFIRMED",
        "KEY_RELEASED",
        "BATCHED",
        "PROVED",
        "ROOT_RELAYED",
        "SETTLING",
        "SETTLED",
      ]
    );
  });
});

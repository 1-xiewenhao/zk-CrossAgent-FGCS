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

describe("PersistentProtocolState v2", function () {
  let temporaryDirectory;
  let databasePath;
  let state;
  let timestamp;

  const rootCommitment = "123456789";
  const payer = "0x1000000000000000000000000000000000000001";
  const buyer = "0x2000000000000000000000000000000000000002";
  const provider = "0x3000000000000000000000000000000000000003";

  beforeEach(function () {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "zk-crossagent-state-")
    );
    databasePath = path.join(temporaryDirectory, "protocol-v2.sqlite");
    timestamp = 1_900_000_000;
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

  function reserve({
    suffix,
    amount,
    nonce = suffix,
    root = rootCommitment,
  }) {
    return state.reserveCall({
      callId: hash(`call-${suffix}`),
      rootCommitment: root,
      childIssuer: buyer,
      childNonce: nonce,
      amount,
      metadata: { suffix },
    });
  }

  function commitAndConfirm(callId) {
    state.recordProviderCommitment(
      callId,
      {
        ciphertextHash: hash("ciphertext"),
        keyCommitment: hash("key"),
      },
      "0x1234"
    );
    state.recordBuyerConfirmation(callId, "0x5678");
  }

  function concurrentReservation(request) {
    return new Promise((resolve, reject) => {
      const worker = fork(
        path.join(__dirname, "../scripts/v2/reservation_worker.js"),
        [],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] }
      );
      let started = false;
      worker.on("message", (message) => {
        if (message.ready && !started) {
          started = true;
          worker.send({
            type: "reserve",
            databasePath,
            timestamp,
            request,
          });
          return;
        }
        if (Object.hasOwn(message, "ok")) resolve(message);
      });
      worker.on("error", reject);
      worker.on("exit", (code) => {
        if (code !== 0) reject(new Error(`reservation worker exited ${code}`));
      });
    });
  }

  it("atomically consumes a nonce and reserves budget exactly once", function () {
    const first = reserve({ suffix: 1, amount: 60, nonce: 77 });
    const replay = reserve({ suffix: 1, amount: 60, nonce: 77 });

    assert.strictEqual(first.idempotent, false);
    assert.strictEqual(replay.idempotent, true);
    assert.throws(
      () => reserve({ suffix: 2, amount: 1, nonce: 77 }),
      /child nonce already consumed/
    );
    assert.deepStrictEqual(state.getRoot(rootCommitment), {
      ...state.getRoot(rootCommitment),
      reservedAmount: 60n,
      reservedCalls: 1,
    });
    assert.strictEqual(state.assertRootInvariant(rootCommitment), true);
  });

  it("rolls back call and nonce insertion when a reservation exceeds budget", function () {
    reserve({ suffix: 1, amount: 60, nonce: 1 });
    assert.throws(
      () => reserve({ suffix: 2, amount: 50, nonce: 2 }),
      /root budget exceeded/
    );
    assert.strictEqual(state.getCall(hash("call-2")), null);

    const replacement = reserve({ suffix: 3, amount: 40, nonce: 2 });
    assert.strictEqual(replacement.state, "RESERVED");
    const root = state.getRoot(rootCommitment);
    assert.strictEqual(root.reservedAmount, 100n);
    assert.strictEqual(root.reservedCalls, 2);
  });

  it("serializes competing reservations across independent processes", async function () {
    const requests = [1, 2].map((suffix) => ({
      callId: hash(`concurrent-${suffix}`),
      rootCommitment,
      childIssuer: buyer,
      childNonce: 900 + suffix,
      amount: 60,
      metadata: { suffix },
    }));
    const results = await Promise.all(
      requests.map((request) => concurrentReservation(request))
    );
    assert.strictEqual(results.filter((result) => result.ok).length, 1);
    assert.match(
      results.find((result) => !result.ok).error,
      /root budget exceeded/
    );
    const root = state.getRoot(rootCommitment);
    assert.strictEqual(root.reservedAmount, 60n);
    assert.strictEqual(root.reservedCalls, 1);
    assert.strictEqual(state.assertRootInvariant(rootCommitment), true);

    const losingIndex = results.findIndex((result) => !result.ok);
    const replacement = state.reserveCall({
      ...requests[losingIndex],
      callId: hash("concurrent-replacement"),
      amount: 40,
    });
    assert.strictEqual(replacement.state, "RESERVED");
    assert.strictEqual(state.getRoot(rootCommitment).reservedAmount, 100n);
  });

  it("persists committed transitions and reservations across restart", function () {
    const call = reserve({ suffix: 1, amount: 25 });
    state.recordProviderCommitment(
      call.callId,
      { ciphertextHash: hash("restart-ciphertext") },
      "0x1234"
    );
    state.close();

    state = new PersistentProtocolState(databasePath, {
      clock: () => timestamp,
    });
    const recovered = state.getCall(call.callId);
    assert.strictEqual(recovered.state, "RESPONSE_COMMITTED");
    assert.strictEqual(
      recovered.providerPayload.ciphertextHash,
      hash("restart-ciphertext")
    );
    assert.strictEqual(state.getRoot(rootCommitment).reservedAmount, 25n);
    assert.strictEqual(state.pendingOutbox().length, 3);
  });

  it("releases only cancellable reservations and retains nonce evidence", function () {
    const expiring = reserve({ suffix: 1, amount: 30 });
    state.expireUnconfirmed(expiring.callId);
    assert.strictEqual(state.getRoot(rootCommitment).reservedAmount, 0n);

    assert.throws(
      () => reserve({ suffix: 2, amount: 1, nonce: 1 }),
      /child nonce already consumed/
    );

    const confirmed = reserve({ suffix: 3, amount: 40 });
    commitAndConfirm(confirmed.callId);
    assert.throws(
      () => state.expireUnconfirmed(confirmed.callId),
      /only unconfirmed reservations may expire/
    );
    assert.strictEqual(state.getRoot(rootCommitment).reservedAmount, 40n);
  });

  it("seals key-released calls atomically and recovers immutable membership", function () {
    const first = reserve({ suffix: 1, amount: 20 });
    const second = reserve({ suffix: 2, amount: 30 });
    for (const call of [first, second]) {
      commitAndConfirm(call.callId);
      state.recordKeyRelease(call.callId, hash("key"), hash("key-hash"));
    }
    const sealed = state.sealBatch({
      epoch: 9,
      batchRoot: 999,
      callIds: [first.callId, second.callId],
    });
    assert.strictEqual(sealed.idempotent, false);
    assert.strictEqual(
      state.sealBatch({
        epoch: 9,
        batchRoot: 999,
        callIds: [first.callId, second.callId],
      }).idempotent,
      true
    );
    assert.throws(
      () =>
        state.sealBatch({
          epoch: 9,
          batchRoot: 1000,
          callIds: [first.callId, second.callId],
        }),
      /conflicts with sealed batch/
    );

    state.close();
    state = new PersistentProtocolState(databasePath, {
      clock: () => timestamp,
    });
    assert.deepStrictEqual(state.getBatch(9).callIds, [
      first.callId,
      second.callId,
    ]);
    assert.strictEqual(state.getCall(first.callId).leafIndex, 0);
    assert.strictEqual(state.getCall(second.callId).leafIndex, 1);
  });

  it("moves reserved counters to settled counters exactly once", function () {
    const call = reserve({ suffix: 1, amount: 25 });
    commitAndConfirm(call.callId);
    state.recordKeyRelease(call.callId, hash("key"), hash("key-hash"));
    state.sealBatch({
      epoch: 1,
      batchRoot: 111,
      callIds: [call.callId],
    });
    state.markProved(call.callId);
    state.markRootRelayed(call.callId);
    state.markSettling(call.callId, hash("settlement-tx"));
    assert.strictEqual(state.markSettled(call.callId).idempotent, false);
    assert.strictEqual(state.markSettled(call.callId).idempotent, true);

    const root = state.getRoot(rootCommitment);
    assert.strictEqual(root.reservedAmount, 0n);
    assert.strictEqual(root.settledAmount, 25n);
    assert.strictEqual(root.reservedCalls, 0);
    assert.strictEqual(root.settledCalls, 1);
    assert.strictEqual(state.assertRootInvariant(rootCommitment), true);
  });
});

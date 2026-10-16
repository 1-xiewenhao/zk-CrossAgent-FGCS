const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  DurableRelayerV2,
} = require("../lib/v2/durable-relayer");

function hex(label, bytes = 32) {
  return `0x${crypto
    .createHash("sha256")
    .update(label)
    .digest("hex")
    .slice(0, bytes * 2)}`;
}

class FakeSource {
  constructor(blockNumber, blockHash) {
    this.latestBlockNumber = blockNumber;
    this.blockHashes = new Map([[blockNumber, blockHash]]);
  }

  async getBlockNumber() {
    return this.latestBlockNumber;
  }

  async getBlockHash(blockNumber) {
    return this.blockHashes.get(blockNumber) || null;
  }
}

class FakeDestination {
  constructor() {
    this.prepared = 0;
    this.broadcasts = [];
    this.receipts = new Map();
    this.applied = new Set();
    this.applicationCount = new Map();
    this.failureMode = null;
  }

  identity(job) {
    return job.idempotencyKey;
  }

  async isApplied(job) {
    return this.applied.has(this.identity(job));
  }

  async prepare(job) {
    this.prepared += 1;
    const rawTransaction = hex(`raw:${job.idempotencyKey}`);
    return {
      rawTransaction,
      transactionHash: hex(`tx:${rawTransaction}`),
    };
  }

  async getTransactionReceipt(transactionHash) {
    return this.receipts.get(transactionHash) || null;
  }

  async broadcastRawTransaction(rawTransaction) {
    this.broadcasts.push(rawTransaction);
    if (this.failureMode === "reject-once") {
      this.failureMode = null;
      throw new Error("temporary RPC rejection");
    }
    const transactionHash = hex(`tx:${rawTransaction}`);
    const identity = this.currentIdentity;
    if (!this.applied.has(identity)) {
      this.applied.add(identity);
      this.applicationCount.set(
        identity,
        (this.applicationCount.get(identity) || 0) + 1
      );
    }
    this.receipts.set(transactionHash, {
      status: 1,
      transactionHash,
    });
    if (this.failureMode === "accept-then-timeout") {
      this.failureMode = null;
      throw new Error("RPC response lost after broadcast");
    }
    return transactionHash;
  }

  bind(job) {
    this.currentIdentity = this.identity(job);
    return this;
  }

  applications(job) {
    return this.applicationCount.get(this.identity(job)) || 0;
  }
}

describe("DurableRelayerV2", function () {
  let temporaryDirectory;
  let databasePath;
  let relayer;
  let timestamp;

  const sourceContract = "0x1000000000000000000000000000000000000001";
  const destinationContract =
    "0x2000000000000000000000000000000000000002";
  const firstEvent = {
    sourceChainId: 80002,
    sourceContract,
    batchEpoch: 7,
    batchRoot: hex("batch-root"),
    sourceTransactionHash: hex("source-tx-a"),
    sourceBlockNumber: 100,
    sourceBlockHash: hex("source-block-a"),
  };

  beforeEach(function () {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "zk-crossagent-relayer-")
    );
    databasePath = path.join(temporaryDirectory, "relayer.sqlite");
    timestamp = 1_900_000_000_000;
    relayer = new DurableRelayerV2(databasePath, {
      finalityDepth: 3,
      clock: () => timestamp,
    });
  });

  afterEach(function () {
    if (relayer?.db?.open) relayer.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  async function finalizedRelayJob(event = firstEvent) {
    const observed = relayer.observeSourceEvent(event);
    const source = new FakeSource(
      event.sourceBlockNumber,
      event.sourceBlockHash
    );
    source.latestBlockNumber = event.sourceBlockNumber + 2;
    const finalized = await relayer.reconcileSource(
      observed.eventKey,
      source
    );
    assert.strictEqual(finalized.status, "FINALIZED");
    return relayer.enqueueFinalizedRelay(observed.eventKey, {
      destinationChainId: 11155111,
      destinationContract,
    });
  }

  it("deduplicates logs and refuses to relay a temporary fork", async function () {
    const first = relayer.observeSourceEvent(firstEvent);
    const duplicate = relayer.observeSourceEvent(firstEvent);
    assert.strictEqual(first.idempotent, false);
    assert.strictEqual(duplicate.idempotent, true);
    assert.strictEqual(duplicate.duplicateCount, 1);

    const source = new FakeSource(101, hex("different-canonical-block"));
    const reorged = await relayer.reconcileSource(first.eventKey, source);
    assert.strictEqual(reorged.status, "REORGED");
    assert.strictEqual(reorged.reorgCount, 1);
    assert.throws(
      () => relayer.enqueueFinalizedRelay(first.eventKey),
      /has not reached finality/
    );

    const canonicalEvent = {
      ...firstEvent,
      sourceTransactionHash: hex("source-tx-b"),
      sourceBlockNumber: 102,
      sourceBlockHash: hex("source-block-b"),
    };
    const reobserved = relayer.observeSourceEvent(canonicalEvent);
    source.blockHashes.set(102, canonicalEvent.sourceBlockHash);
    source.latestBlockNumber = 104;
    const finalized = await relayer.reconcileSource(
      reobserved.eventKey,
      source
    );
    assert.strictEqual(finalized.status, "FINALIZED");
    const relayJob = relayer.enqueueFinalizedRelay(reobserved.eventKey);
    const duplicateJob = relayer.enqueueFinalizedRelay(reobserved.eventKey);
    assert.strictEqual(relayJob.idempotent, false);
    assert.strictEqual(duplicateJob.idempotent, true);
    assert.strictEqual(relayer.pendingDestinationJobs().length, 1);
  });

  it("recovers after a crash between transaction persistence and broadcast", async function () {
    const job = await finalizedRelayJob();
    const destination = new FakeDestination().bind(job);
    await assert.rejects(
      relayer.processDestinationJob(job.jobKey, destination, {
        afterPersistBeforeBroadcast: async () => {
          throw new Error("injected crash after durable transaction");
        },
      }),
      /injected crash/
    );
    const persisted = relayer.getDestinationJob(job.jobKey);
    assert.strictEqual(persisted.status, "SUBMITTED");
    assert.ok(persisted.rawTransaction);
    assert.strictEqual(destination.broadcasts.length, 0);

    relayer.close();
    relayer = new DurableRelayerV2(databasePath, {
      finalityDepth: 3,
      clock: () => timestamp,
    });
    const recovered = await relayer.processDestinationJob(
      job.jobKey,
      destination.bind(job)
    );
    assert.strictEqual(recovered.status, "CONFIRMED");
    assert.strictEqual(destination.applications(job), 1);
    assert.strictEqual(relayer.getSourceEvent(job.sourceEventKey).status, "RELAYED");
  });

  it("recovers when RPC loses the response after accepting the transaction", async function () {
    const job = await finalizedRelayJob();
    const destination = new FakeDestination().bind(job);
    destination.failureMode = "accept-then-timeout";
    await assert.rejects(
      relayer.processDestinationJob(job.jobKey, destination),
      /response lost/
    );
    assert.strictEqual(destination.applications(job), 1);
    assert.strictEqual(
      relayer.getDestinationJob(job.jobKey).status,
      "SUBMITTED"
    );

    relayer.close();
    relayer = new DurableRelayerV2(databasePath, {
      finalityDepth: 3,
      clock: () => timestamp,
    });
    const recovered = await relayer.processDestinationJob(
      job.jobKey,
      destination.bind(job)
    );
    assert.strictEqual(recovered.status, "CONFIRMED");
    assert.strictEqual(recovered.recoveredFromDestinationState, true);
    assert.strictEqual(destination.applications(job), 1);
  });

  it("retries the identical signed transaction after transient RPC rejection", async function () {
    const job = await finalizedRelayJob();
    const destination = new FakeDestination().bind(job);
    destination.failureMode = "reject-once";
    await assert.rejects(
      relayer.processDestinationJob(job.jobKey, destination),
      /temporary RPC rejection/
    );
    const firstRawTransaction =
      relayer.getDestinationJob(job.jobKey).rawTransaction;

    relayer.close();
    relayer = new DurableRelayerV2(databasePath, {
      finalityDepth: 3,
      clock: () => timestamp,
    });
    const confirmed = await relayer.processDestinationJob(
      job.jobKey,
      destination.bind(job)
    );
    assert.strictEqual(confirmed.status, "CONFIRMED");
    assert.deepStrictEqual(destination.broadcasts, [
      firstRawTransaction,
      firstRawTransaction,
    ]);
    assert.strictEqual(confirmed.prepareAttempts, 1);
    assert.strictEqual(confirmed.broadcastAttempts, 2);
    assert.strictEqual(destination.applications(job), 1);
  });

  it("deduplicates settlement jobs and treats destination state as authority", async function () {
    const callId = hex("settlement-call");
    const job = relayer.enqueueSettlement({
      callId,
      payload: { amount: "25" },
    });
    const duplicate = relayer.enqueueSettlement({
      callId,
      payload: { amount: "25" },
    });
    assert.strictEqual(job.idempotent, false);
    assert.strictEqual(duplicate.idempotent, true);

    const destination = new FakeDestination().bind(job);
    const first = await relayer.processDestinationJob(
      job.jobKey,
      destination
    );
    const replay = await relayer.processDestinationJob(
      job.jobKey,
      destination
    );
    assert.strictEqual(first.status, "CONFIRMED");
    assert.strictEqual(replay.idempotent, true);
    assert.strictEqual(destination.applications(job), 1);
  });
});

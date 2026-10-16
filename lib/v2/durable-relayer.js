const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const SOURCE_STATES = Object.freeze({
  OBSERVED: "OBSERVED",
  REORGED: "REORGED",
  FINALIZED: "FINALIZED",
  RELAYED: "RELAYED",
});

const DESTINATION_STATES = Object.freeze({
  READY: "READY",
  SUBMITTED: "SUBMITTED",
  CONFIRMED: "CONFIRMED",
});

function canonicalHex(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label} must be a 0x-prefixed hexadecimal string`);
  }
  return value.toLowerCase();
}

function canonicalAddress(value, label) {
  const result = canonicalHex(value, label);
  if (result.length !== 42) {
    throw new Error(`${label} must be a 20-byte address`);
  }
  return result;
}

function safeInteger(value, label) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return result;
}

function json(value) {
  return JSON.stringify(value);
}

class DurableRelayerV2 {
  constructor(databasePath, options = {}) {
    if (!databasePath) throw new Error("databasePath is required");
    if (databasePath !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(databasePath)), {
        recursive: true,
      });
    }
    this.databasePath = databasePath;
    this.finalityDepth = safeInteger(
      options.finalityDepth ?? 12,
      "finalityDepth"
    );
    if (this.finalityDepth < 1) {
      throw new Error("finalityDepth must be at least one block");
    }
    this.clock = options.clock || (() => Date.now());
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_source_events (
        event_key TEXT PRIMARY KEY,
        source_chain_id INTEGER NOT NULL,
        source_contract TEXT NOT NULL,
        batch_epoch INTEGER NOT NULL,
        batch_root TEXT NOT NULL,
        source_tx_hash TEXT NOT NULL,
        source_block_number INTEGER NOT NULL,
        source_block_hash TEXT NOT NULL,
        confirmations INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (
          status IN ('OBSERVED', 'REORGED', 'FINALIZED', 'RELAYED')
        ),
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        reorg_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (
          source_chain_id, source_contract, batch_epoch, batch_root
        )
      );

      CREATE TABLE IF NOT EXISTS destination_jobs (
        job_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('ROOT_RELAY', 'SETTLEMENT')),
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        source_event_key TEXT REFERENCES relay_source_events(event_key),
        status TEXT NOT NULL CHECK (
          status IN ('READY', 'SUBMITTED', 'CONFIRMED')
        ),
        transaction_hash TEXT,
        raw_transaction TEXT,
        prepare_attempts INTEGER NOT NULL DEFAULT 0,
        broadcast_attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS relay_source_status_idx
        ON relay_source_events(status, source_block_number);
      CREATE INDEX IF NOT EXISTS destination_job_status_idx
        ON destination_jobs(status, created_at);
    `);
  }

  close() {
    this.db.close();
  }

  checkpoint() {
    return this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  static sourceEventKey(event) {
    return [
      safeInteger(event.sourceChainId, "sourceChainId"),
      canonicalAddress(event.sourceContract, "sourceContract"),
      safeInteger(event.batchEpoch, "batchEpoch"),
      canonicalHex(event.batchRoot, "batchRoot"),
    ].join(":");
  }

  observeSourceEvent(event) {
    const record = {
      eventKey: DurableRelayerV2.sourceEventKey(event),
      sourceChainId: safeInteger(event.sourceChainId, "sourceChainId"),
      sourceContract: canonicalAddress(
        event.sourceContract,
        "sourceContract"
      ),
      batchEpoch: safeInteger(event.batchEpoch, "batchEpoch"),
      batchRoot: canonicalHex(event.batchRoot, "batchRoot"),
      sourceTransactionHash: canonicalHex(
        event.sourceTransactionHash,
        "sourceTransactionHash"
      ),
      sourceBlockNumber: safeInteger(
        event.sourceBlockNumber,
        "sourceBlockNumber"
      ),
      sourceBlockHash: canonicalHex(
        event.sourceBlockHash,
        "sourceBlockHash"
      ),
    };
    const timestamp = this.clock();
    const transaction = this.db.transaction(() => {
      const existing = this._sourceRow(record.eventKey);
      if (!existing) {
        this.db
          .prepare(`
            INSERT INTO relay_source_events (
              event_key, source_chain_id, source_contract, batch_epoch,
              batch_root, source_tx_hash, source_block_number,
              source_block_hash, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OBSERVED', ?, ?)
          `)
          .run(
            record.eventKey,
            record.sourceChainId,
            record.sourceContract,
            record.batchEpoch,
            record.batchRoot,
            record.sourceTransactionHash,
            record.sourceBlockNumber,
            record.sourceBlockHash,
            timestamp,
            timestamp
          );
        return {
          ...this.getSourceEvent(record.eventKey),
          idempotent: false,
        };
      }
      const sameOccurrence =
        existing.source_tx_hash === record.sourceTransactionHash &&
        existing.source_block_number === record.sourceBlockNumber &&
        existing.source_block_hash === record.sourceBlockHash;
      if (sameOccurrence && existing.status !== SOURCE_STATES.REORGED) {
        this.db
          .prepare(`
            UPDATE relay_source_events
            SET duplicate_count = duplicate_count + 1, updated_at = ?
            WHERE event_key = ?
          `)
          .run(timestamp, record.eventKey);
        return {
          ...this.getSourceEvent(record.eventKey),
          idempotent: true,
        };
      }
      if (
        [SOURCE_STATES.FINALIZED, SOURCE_STATES.RELAYED].includes(
          existing.status
        )
      ) {
        throw new Error("finalized source event conflicts with another fork");
      }
      this.db
        .prepare(`
          UPDATE relay_source_events
          SET source_tx_hash = ?, source_block_number = ?,
              source_block_hash = ?, confirmations = 0,
              status = 'OBSERVED', updated_at = ?
          WHERE event_key = ?
        `)
        .run(
          record.sourceTransactionHash,
          record.sourceBlockNumber,
          record.sourceBlockHash,
          timestamp,
          record.eventKey
        );
      return {
        ...this.getSourceEvent(record.eventKey),
        idempotent: false,
      };
    });
    return transaction.immediate();
  }

  async reconcileSource(eventKey, sourceAdapter) {
    const event = this.getSourceEvent(eventKey);
    if (!event) throw new Error("unknown source event");
    if (event.status === SOURCE_STATES.RELAYED) return event;
    const [latestBlockNumber, canonicalBlockHash] = await Promise.all([
      sourceAdapter.getBlockNumber(),
      sourceAdapter.getBlockHash(event.sourceBlockNumber),
    ]);
    const timestamp = this.clock();
    if (
      !canonicalBlockHash ||
      canonicalHex(canonicalBlockHash, "canonicalBlockHash") !==
        event.sourceBlockHash
    ) {
      this.db
        .prepare(`
          UPDATE relay_source_events
          SET status = 'REORGED', confirmations = 0,
              reorg_count = reorg_count + 1, updated_at = ?
          WHERE event_key = ? AND status NOT IN ('FINALIZED', 'RELAYED')
        `)
        .run(timestamp, eventKey);
      const current = this.getSourceEvent(eventKey);
      if (
        [SOURCE_STATES.FINALIZED, SOURCE_STATES.RELAYED].includes(
          current.status
        )
      ) {
        throw new Error("source reorg crossed the configured finality depth");
      }
      return current;
    }
    const confirmations = Math.max(
      0,
      safeInteger(latestBlockNumber, "latestBlockNumber") -
        event.sourceBlockNumber +
        1
    );
    const status =
      confirmations >= this.finalityDepth
        ? SOURCE_STATES.FINALIZED
        : SOURCE_STATES.OBSERVED;
    this.db
      .prepare(`
        UPDATE relay_source_events
        SET confirmations = ?, status = ?, updated_at = ?
        WHERE event_key = ? AND status != 'RELAYED'
      `)
      .run(confirmations, status, timestamp, eventKey);
    return this.getSourceEvent(eventKey);
  }

  enqueueFinalizedRelay(eventKey, destination = {}) {
    const source = this.getSourceEvent(eventKey);
    if (!source) throw new Error("unknown source event");
    if (
      ![SOURCE_STATES.FINALIZED, SOURCE_STATES.RELAYED].includes(
        source.status
      )
    ) {
      throw new Error("source event has not reached finality");
    }
    return this._enqueueDestination({
      kind: "ROOT_RELAY",
      idempotencyKey: `ROOT_RELAY:${eventKey}`,
      sourceEventKey: eventKey,
      payload: {
        sourceChainId: source.sourceChainId,
        sourceContract: source.sourceContract,
        batchEpoch: source.batchEpoch,
        batchRoot: source.batchRoot,
        destinationChainId: destination.destinationChainId ?? null,
        destinationContract: destination.destinationContract ?? null,
      },
    });
  }

  enqueueSettlement({ callId, payload = {} }) {
    const canonicalCallId = canonicalHex(callId, "callId");
    return this._enqueueDestination({
      kind: "SETTLEMENT",
      idempotencyKey: `SETTLEMENT:${canonicalCallId}`,
      sourceEventKey: null,
      payload: { ...payload, callId: canonicalCallId },
    });
  }

  _enqueueDestination({
    kind,
    idempotencyKey,
    sourceEventKey,
    payload,
  }) {
    const jobKey = idempotencyKey;
    const timestamp = this.clock();
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO destination_jobs (
          job_key, kind, idempotency_key, payload_json,
          source_event_key, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'READY', ?, ?)
      `)
      .run(
        jobKey,
        kind,
        idempotencyKey,
        json(payload),
        sourceEventKey,
        timestamp,
        timestamp
      );
    const job = this.getDestinationJob(jobKey);
    if (json(job.payload) !== json(payload) || job.kind !== kind) {
      throw new Error("idempotency key conflicts with another payload");
    }
    return { ...job, idempotent: result.changes === 0 };
  }

  async processDestinationJob(jobKey, destinationAdapter, hooks = {}) {
    let job = this.getDestinationJob(jobKey);
    if (!job) throw new Error("unknown destination job");
    if (job.status === DESTINATION_STATES.CONFIRMED) {
      return { ...job, idempotent: true };
    }
    if (await destinationAdapter.isApplied(job)) {
      return {
        ...this._markDestinationConfirmed(jobKey),
        recoveredFromDestinationState: true,
      };
    }

    if (job.status === DESTINATION_STATES.READY) {
      const prepared = await destinationAdapter.prepare(job);
      const transactionHash = canonicalHex(
        prepared.transactionHash,
        "transactionHash"
      );
      const rawTransaction = canonicalHex(
        prepared.rawTransaction,
        "rawTransaction"
      );
      this.db
        .prepare(`
          UPDATE destination_jobs
          SET status = 'SUBMITTED', transaction_hash = ?,
              raw_transaction = ?, prepare_attempts = prepare_attempts + 1,
              last_error = NULL, updated_at = ?
          WHERE job_key = ? AND status = 'READY'
        `)
        .run(transactionHash, rawTransaction, this.clock(), jobKey);
      job = this.getDestinationJob(jobKey);
      if (hooks.afterPersistBeforeBroadcast) {
        await hooks.afterPersistBeforeBroadcast(job);
      }
    }

    const receipt = await destinationAdapter.getTransactionReceipt(
      job.transactionHash
    );
    if (receipt) {
      if (Number(receipt.status) !== 1) {
        throw new Error("destination transaction reverted");
      }
      if (!(await destinationAdapter.isApplied(job))) {
        throw new Error("receipt succeeded but destination state is absent");
      }
      return this._markDestinationConfirmed(jobKey);
    }

    this.db
      .prepare(`
        UPDATE destination_jobs
        SET broadcast_attempts = broadcast_attempts + 1, updated_at = ?
        WHERE job_key = ?
      `)
      .run(this.clock(), jobKey);
    try {
      await destinationAdapter.broadcastRawTransaction(job.rawTransaction);
      if (hooks.afterBroadcastBeforeReceipt) {
        await hooks.afterBroadcastBeforeReceipt(job);
      }
    } catch (error) {
      this.db
        .prepare(`
          UPDATE destination_jobs
          SET last_error = ?, updated_at = ?
          WHERE job_key = ?
        `)
        .run(String(error.message || error), this.clock(), jobKey);
      throw error;
    }

    const finalReceipt = await destinationAdapter.getTransactionReceipt(
      job.transactionHash
    );
    if (!finalReceipt) {
      return { ...this.getDestinationJob(jobKey), pending: true };
    }
    if (Number(finalReceipt.status) !== 1) {
      throw new Error("destination transaction reverted");
    }
    if (!(await destinationAdapter.isApplied(job))) {
      throw new Error("receipt succeeded but destination state is absent");
    }
    return this._markDestinationConfirmed(jobKey);
  }

  _markDestinationConfirmed(jobKey) {
    const timestamp = this.clock();
    const transaction = this.db.transaction(() => {
      const job = this._destinationRow(jobKey);
      if (!job) throw new Error("unknown destination job");
      this.db
        .prepare(`
          UPDATE destination_jobs
          SET status = 'CONFIRMED', last_error = NULL, updated_at = ?
          WHERE job_key = ?
        `)
        .run(timestamp, jobKey);
      if (job.source_event_key) {
        this.db
          .prepare(`
            UPDATE relay_source_events
            SET status = 'RELAYED', updated_at = ?
            WHERE event_key = ? AND status IN ('FINALIZED', 'RELAYED')
          `)
          .run(timestamp, job.source_event_key);
      }
      return this.getDestinationJob(jobKey);
    });
    return transaction.immediate();
  }

  getSourceEvent(eventKey) {
    const row = this._sourceRow(eventKey);
    return row
      ? {
          eventKey: row.event_key,
          sourceChainId: row.source_chain_id,
          sourceContract: row.source_contract,
          batchEpoch: row.batch_epoch,
          batchRoot: row.batch_root,
          sourceTransactionHash: row.source_tx_hash,
          sourceBlockNumber: row.source_block_number,
          sourceBlockHash: row.source_block_hash,
          confirmations: row.confirmations,
          status: row.status,
          duplicateCount: row.duplicate_count,
          reorgCount: row.reorg_count,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  }

  getDestinationJob(jobKey) {
    const row = this._destinationRow(jobKey);
    return row
      ? {
          jobKey: row.job_key,
          kind: row.kind,
          idempotencyKey: row.idempotency_key,
          payload: JSON.parse(row.payload_json),
          sourceEventKey: row.source_event_key,
          status: row.status,
          transactionHash: row.transaction_hash,
          rawTransaction: row.raw_transaction,
          prepareAttempts: row.prepare_attempts,
          broadcastAttempts: row.broadcast_attempts,
          lastError: row.last_error,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  }

  pendingDestinationJobs(limit = 100) {
    return this.db
      .prepare(`
        SELECT job_key FROM destination_jobs
        WHERE status != 'CONFIRMED'
        ORDER BY created_at, job_key
        LIMIT ?
      `)
      .all(safeInteger(limit, "limit"))
      .map((row) => this.getDestinationJob(row.job_key));
  }

  _sourceRow(eventKey) {
    return this.db
      .prepare("SELECT * FROM relay_source_events WHERE event_key = ?")
      .get(eventKey);
  }

  _destinationRow(jobKey) {
    return this.db
      .prepare("SELECT * FROM destination_jobs WHERE job_key = ?")
      .get(jobKey);
  }
}

module.exports = {
  DESTINATION_STATES,
  DurableRelayerV2,
  SOURCE_STATES,
};

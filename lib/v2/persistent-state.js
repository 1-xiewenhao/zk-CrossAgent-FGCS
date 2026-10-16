const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const CALL_STATES = Object.freeze({
  RESERVED: "RESERVED",
  RESPONSE_COMMITTED: "RESPONSE_COMMITTED",
  BUYER_CONFIRMED: "BUYER_CONFIRMED",
  KEY_RELEASED: "KEY_RELEASED",
  BATCHED: "BATCHED",
  PROVED: "PROVED",
  ROOT_RELAYED: "ROOT_RELAYED",
  SETTLING: "SETTLING",
  SETTLED: "SETTLED",
  EXPIRED: "EXPIRED",
  FAILED_PERMANENT: "FAILED_PERMANENT",
});

const FORWARD_TRANSITIONS = Object.freeze({
  RESERVED: new Set(["RESPONSE_COMMITTED", "EXPIRED"]),
  RESPONSE_COMMITTED: new Set(["BUYER_CONFIRMED", "EXPIRED"]),
  BUYER_CONFIRMED: new Set(["KEY_RELEASED", "FAILED_PERMANENT"]),
  KEY_RELEASED: new Set(["BATCHED"]),
  BATCHED: new Set(["PROVED"]),
  PROVED: new Set(["ROOT_RELAYED"]),
  ROOT_RELAYED: new Set(["SETTLING"]),
  SETTLING: new Set(["SETTLED"]),
  SETTLED: new Set(),
  EXPIRED: new Set(),
  FAILED_PERMANENT: new Set(),
});

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function canonicalHex(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label} must be a 0x-prefixed hexadecimal string`);
  }
  return value.toLowerCase();
}

function canonicalAddress(value, label) {
  const canonical = canonicalHex(value, label);
  if (canonical.length !== 42) {
    throw new Error(`${label} must be a 20-byte address`);
  }
  return canonical;
}

function uintString(value, label) {
  const numeric = BigInt(value);
  if (numeric < 0n) throw new Error(`${label} must be unsigned`);
  return numeric.toString();
}

function parseJson(value) {
  return value === null ? null : JSON.parse(value);
}

class PersistentProtocolState {
  constructor(databasePath, options = {}) {
    if (!databasePath) throw new Error("databasePath is required");
    if (databasePath !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(databasePath)), {
        recursive: true,
      });
    }
    this.databasePath = databasePath;
    this.clock = options.clock || nowSeconds;
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this._migrate();
    this._prepare();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS roots (
        root_commitment TEXT PRIMARY KEY,
        payer TEXT NOT NULL,
        buyer TEXT NOT NULL,
        budget TEXT NOT NULL,
        max_subcalls INTEGER NOT NULL CHECK (max_subcalls > 0),
        expiry INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSE_REQUESTED', 'CLOSED', 'EXPIRED')),
        reserved_amount TEXT NOT NULL DEFAULT '0',
        settled_amount TEXT NOT NULL DEFAULT '0',
        reserved_calls INTEGER NOT NULL DEFAULT 0,
        settled_calls INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS root_budget_releases (
        root_commitment TEXT PRIMARY KEY REFERENCES roots(root_commitment),
        snapshot_json TEXT NOT NULL,
        authorization_json TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS calls (
        call_id TEXT PRIMARY KEY,
        root_commitment TEXT NOT NULL REFERENCES roots(root_commitment),
        child_issuer TEXT NOT NULL,
        child_nonce TEXT NOT NULL,
        amount TEXT NOT NULL,
        state TEXT NOT NULL,
        request_json TEXT NOT NULL,
        provider_payload_json TEXT,
        provider_signature TEXT,
        buyer_signature TEXT,
        key_reveal TEXT,
        key_reveal_hash TEXT,
        batch_epoch INTEGER,
        leaf_index INTEGER,
        settlement_tx_hash TEXT,
        failure_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS consumed_child_nonces (
        child_issuer TEXT NOT NULL,
        child_nonce TEXT NOT NULL,
        call_id TEXT NOT NULL UNIQUE REFERENCES calls(call_id),
        consumed_at INTEGER NOT NULL,
        PRIMARY KEY (child_issuer, child_nonce)
      );

      CREATE TABLE IF NOT EXISTS call_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id TEXT NOT NULL REFERENCES calls(call_id),
        from_state TEXT,
        to_state TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS batches (
        epoch INTEGER PRIMARY KEY,
        batch_root TEXT NOT NULL UNIQUE,
        real_count INTEGER NOT NULL CHECK (real_count > 0 AND real_count <= 16),
        state TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS batch_members (
        batch_epoch INTEGER NOT NULL REFERENCES batches(epoch),
        call_id TEXT NOT NULL UNIQUE REFERENCES calls(call_id),
        leaf_index INTEGER NOT NULL CHECK (leaf_index >= 0 AND leaf_index < 16),
        PRIMARY KEY (batch_epoch, leaf_index)
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS calls_state_idx ON calls(state);
      CREATE INDEX IF NOT EXISTS outbox_pending_idx
        ON outbox(delivered_at, id);
    `);
  }

  _prepare() {
    this.statements = {
      root: this.db.prepare(
        "SELECT * FROM roots WHERE root_commitment = ?"
      ),
      call: this.db.prepare("SELECT * FROM calls WHERE call_id = ?"),
      batch: this.db.prepare("SELECT * FROM batches WHERE epoch = ?"),
      insertTransition: this.db.prepare(`
        INSERT INTO call_transitions
          (call_id, from_state, to_state, reason, created_at)
        VALUES (?, ?, ?, ?, ?)
      `),
      insertOutbox: this.db.prepare(`
        INSERT OR IGNORE INTO outbox
          (dedupe_key, event_type, aggregate_id, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `),
    };
  }

  close() {
    this.db.close();
  }

  checkpoint() {
    return this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  _outbox(eventType, aggregateId, payload, timestamp, suffix = "") {
    const dedupeKey = `${eventType}:${aggregateId}:${suffix}`;
    this.statements.insertOutbox.run(
      dedupeKey,
      eventType,
      aggregateId,
      JSON.stringify(payload),
      timestamp
    );
  }

  registerRoot(root) {
    const timestamp = this.clock();
    const record = {
      rootCommitment: uintString(
        root.rootCommitment ?? root.capabilityCommitment,
        "rootCommitment"
      ),
      payer: canonicalAddress(root.payer, "payer"),
      buyer: canonicalAddress(root.buyer, "buyer"),
      budget: uintString(root.budget, "budget"),
      maxSubcalls: Number(root.maxSubcalls),
      expiry: Number(root.expiry),
      metadata: root.metadata || {},
    };
    if (!Number.isSafeInteger(record.maxSubcalls) || record.maxSubcalls < 1) {
      throw new Error("maxSubcalls must be a positive safe integer");
    }
    if (!Number.isSafeInteger(record.expiry) || record.expiry <= timestamp) {
      throw new Error("root must expire in the future");
    }

    const transaction = this.db.transaction(() => {
      const existing = this.statements.root.get(record.rootCommitment);
      if (existing) {
        const same =
          existing.payer === record.payer &&
          existing.buyer === record.buyer &&
          existing.budget === record.budget &&
          existing.max_subcalls === record.maxSubcalls &&
          existing.expiry === record.expiry;
        if (!same) throw new Error("root commitment conflicts with stored root");
        return { ...this._mapRoot(existing), idempotent: true };
      }
      this.db
        .prepare(`
          INSERT INTO roots (
            root_commitment, payer, buyer, budget, max_subcalls, expiry,
            status, metadata_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)
        `)
        .run(
          record.rootCommitment,
          record.payer,
          record.buyer,
          record.budget,
          record.maxSubcalls,
          record.expiry,
          JSON.stringify(record.metadata),
          timestamp,
          timestamp
        );
      this._outbox(
        "ROOT_REGISTERED",
        record.rootCommitment,
        record,
        timestamp
      );
      return {
        ...this._mapRoot(this.statements.root.get(record.rootCommitment)),
        idempotent: false,
      };
    });
    return transaction.immediate();
  }

  prepareRootBudgetRelease(rootCommitmentValue, snapshot) {
    const rootCommitment = uintString(rootCommitmentValue, "rootCommitment");
    const transaction = this.db.transaction(() => {
      const root = this.getRoot(rootCommitment);
      if (!root) throw new Error("unknown root");
      if (root.expiry > this.clock()) throw new Error("root is not expired");
      if (
        snapshot.payer.toLowerCase() !== root.payer ||
        Number(snapshot.expiry) !== root.expiry ||
        BigInt(snapshot.budget) !== root.budget ||
        Number(snapshot.maxSubcalls) !== root.maxSubcalls ||
        BigInt(snapshot.settledAmount) !== root.settledAmount ||
        Number(snapshot.settledCalls) !== root.settledCalls
      ) throw new Error("finalized settlement snapshot disagrees with gateway");
      const pending = this.db.prepare(
        "SELECT COUNT(*) AS n FROM calls WHERE root_commitment = ? AND state NOT IN ('SETTLED','EXPIRED','FAILED_PERMANENT')"
      ).get(rootCommitment).n;
      if (root.reservedAmount !== 0n || root.reservedCalls !== 0 || pending !== 0) {
        throw new Error("root has outstanding obligations");
      }
      // Permanently fence admission before signing, including across clock rollback/restart.
      const now = this.clock();
      this.db.prepare("UPDATE roots SET status = 'EXPIRED', updated_at = ? WHERE root_commitment = ?")
        .run(now, rootCommitment);
      this.db.prepare("INSERT INTO root_budget_releases (root_commitment,snapshot_json,updated_at) VALUES (?,?,?) ON CONFLICT(root_commitment) DO UPDATE SET snapshot_json=excluded.snapshot_json, updated_at=excluded.updated_at")
        .run(rootCommitment, JSON.stringify(snapshot), now);
      this._outbox("ROOT_BUDGET_RELEASE_PREPARED", rootCommitment, { rootCommitment }, now);
      return root;
    });
    return transaction.immediate();
  }

  recordRootBudgetReleaseAuthorization(rootCommitmentValue, authorization) {
    const rootCommitment = uintString(rootCommitmentValue, "rootCommitment");
    const result = this.db.prepare(
      "UPDATE root_budget_releases SET authorization_json = ?, updated_at = ? WHERE root_commitment = ?"
    ).run(JSON.stringify(authorization), this.clock(), rootCommitment);
    if (result.changes !== 1) throw new Error("root budget release was not prepared");
    return authorization;
  }

  getRootBudgetRelease(rootCommitmentValue) {
    const row = this.db.prepare("SELECT * FROM root_budget_releases WHERE root_commitment = ?")
      .get(uintString(rootCommitmentValue, "rootCommitment"));
    return row ? { snapshot: JSON.parse(row.snapshot_json),
      authorization: parseJson(row.authorization_json), updatedAt: row.updated_at } : null;
  }

  reserveCall(request) {
    const callId = canonicalHex(request.callId, "callId");
    const rootCommitment = uintString(
      request.rootCommitment,
      "rootCommitment"
    );
    const childIssuer = canonicalAddress(
      request.childIssuer,
      "childIssuer"
    );
    const childNonce = uintString(request.childNonce, "childNonce");
    const childExpiry = request.childExpiry === undefined
      ? null
      : BigInt(uintString(request.childExpiry, "childExpiry"));
    const amount = uintString(request.amount, "amount");
    if (BigInt(amount) === 0n) throw new Error("amount must be positive");

    const transaction = this.db.transaction(() => {
      const existing = this.statements.call.get(callId);
      if (existing) {
        const same =
          existing.root_commitment === rootCommitment &&
          existing.child_issuer === childIssuer &&
          existing.child_nonce === childNonce &&
          existing.amount === amount;
        if (!same) throw new Error("callId conflicts with stored request");
        return { ...this._mapCall(existing), idempotent: true };
      }

      // Sample time after the write lock is acquired, before consuming a nonce.
      // An existing call above is only an idempotent lookup, not a new admission.
      const timestamp = this.clock();
      const root = this.statements.root.get(rootCommitment);
      if (!root) throw new Error("unknown root");
      if (root.status !== "OPEN") throw new Error("root is not open");
      if (root.expiry <= timestamp) throw new Error("root is expired");
      if (childExpiry !== null && childExpiry <= BigInt(timestamp)) {
        throw new Error("child is expired");
      }

      const projectedAmount =
        BigInt(root.reserved_amount) +
        BigInt(root.settled_amount) +
        BigInt(amount);
      if (projectedAmount > BigInt(root.budget)) {
        throw new Error("root budget exceeded");
      }
      const projectedCalls =
        root.reserved_calls + root.settled_calls + 1;
      if (projectedCalls > root.max_subcalls) {
        throw new Error("root call limit exceeded");
      }

      this.db
        .prepare(`
          INSERT INTO calls (
            call_id, root_commitment, child_issuer, child_nonce, amount,
            state, request_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'RESERVED', ?, ?, ?)
        `)
        .run(
          callId,
          rootCommitment,
          childIssuer,
          childNonce,
          amount,
          JSON.stringify(request.metadata || {}),
          timestamp,
          timestamp
        );
      this.db
        .prepare(`
          INSERT INTO consumed_child_nonces
            (child_issuer, child_nonce, call_id, consumed_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(childIssuer, childNonce, callId, timestamp);
      this.db
        .prepare(`
          UPDATE roots
          SET reserved_amount = ?, reserved_calls = reserved_calls + 1,
              updated_at = ?
          WHERE root_commitment = ?
        `)
        .run(
          (BigInt(root.reserved_amount) + BigInt(amount)).toString(),
          timestamp,
          rootCommitment
        );
      this.statements.insertTransition.run(
        callId,
        null,
        "RECEIVED",
        "authenticated invoke",
        timestamp
      );
      this.statements.insertTransition.run(
        callId,
        "RECEIVED",
        "RESERVED",
        "nonce consumed and budget reserved",
        timestamp
      );
      this._outbox(
        "CALL_RESERVED",
        callId,
        { callId, rootCommitment, amount },
        timestamp
      );
      return {
        ...this._mapCall(this.statements.call.get(callId)),
        idempotent: false,
      };
    });
    try {
      return transaction.immediate();
    } catch (error) {
      if (
        error.code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
        error.code === "SQLITE_CONSTRAINT_UNIQUE"
      ) {
        throw new Error("child nonce already consumed");
      }
      throw error;
    }
  }

  recordProviderCommitment(callId, payload, providerSignature) {
    return this._transition(
      callId,
      CALL_STATES.RESPONSE_COMMITTED,
      {
        provider_payload_json: JSON.stringify(payload),
        provider_signature: canonicalHex(
          providerSignature,
          "providerSignature"
        ),
      },
      "provider committed encrypted response"
    );
  }

  recordBuyerConfirmation(callId, buyerSignature) {
    return this._transition(
      callId,
      CALL_STATES.BUYER_CONFIRMED,
      {
        buyer_signature: canonicalHex(buyerSignature, "buyerSignature"),
      },
      "buyer nested confirmation verified"
    );
  }

  recordKeyRelease(callId, keyReveal, keyRevealHash) {
    return this._transition(
      callId,
      CALL_STATES.KEY_RELEASED,
      {
        key_reveal: canonicalHex(keyReveal, "keyReveal"),
        key_reveal_hash: canonicalHex(keyRevealHash, "keyRevealHash"),
      },
      "provider key reveal verified"
    );
  }

  markProved(callId) {
    return this._transition(
      callId,
      CALL_STATES.PROVED,
      {},
      "service-chain proof accepted"
    );
  }

  markRootRelayed(callId) {
    return this._transition(
      callId,
      CALL_STATES.ROOT_RELAYED,
      {},
      "finalized root accepted on settlement chain"
    );
  }

  markSettling(callId, transactionHash) {
    return this._transition(
      callId,
      CALL_STATES.SETTLING,
      {
        settlement_tx_hash: canonicalHex(
          transactionHash,
          "transactionHash"
        ),
      },
      "settlement transaction submitted"
    );
  }

  expireUnconfirmed(callId, reason = "confirmation deadline elapsed") {
    const call = this.getCall(callId);
    if (
      !call ||
      ![CALL_STATES.RESERVED, CALL_STATES.RESPONSE_COMMITTED].includes(
        call.state
      )
    ) {
      throw new Error("only unconfirmed reservations may expire");
    }
    return this._releaseReservation(
      callId,
      CALL_STATES.EXPIRED,
      reason
    );
  }

  failMissingKey(callId, reason) {
    if (!reason) throw new Error("provider failure reason is required");
    const call = this.getCall(callId);
    if (!call || call.state !== CALL_STATES.BUYER_CONFIRMED) {
      throw new Error("only a buyer-confirmed call may fail key release");
    }
    return this._releaseReservation(
      callId,
      CALL_STATES.FAILED_PERMANENT,
      reason
    );
  }

  _releaseReservation(callIdValue, targetState, reason) {
    const callId = canonicalHex(callIdValue, "callId");
    const timestamp = this.clock();
    const transaction = this.db.transaction(() => {
      const call = this.statements.call.get(callId);
      if (!call) throw new Error("unknown call");
      if (call.state === targetState) return this._mapCall(call);
      const allowed = FORWARD_TRANSITIONS[call.state];
      if (!allowed || !allowed.has(targetState)) {
        throw new Error(`invalid call transition ${call.state} -> ${targetState}`);
      }
      const root = this.statements.root.get(call.root_commitment);
      const nextReserved = BigInt(root.reserved_amount) - BigInt(call.amount);
      if (nextReserved < 0n || root.reserved_calls < 1) {
        throw new Error("reservation counters are inconsistent");
      }
      this.db
        .prepare(`
          UPDATE roots
          SET reserved_amount = ?, reserved_calls = reserved_calls - 1,
              updated_at = ?
          WHERE root_commitment = ?
        `)
        .run(nextReserved.toString(), timestamp, call.root_commitment);
      this.db
        .prepare(`
          UPDATE calls
          SET state = ?, failure_reason = ?, updated_at = ?
          WHERE call_id = ?
        `)
        .run(targetState, reason, timestamp, callId);
      this.statements.insertTransition.run(
        callId,
        call.state,
        targetState,
        reason,
        timestamp
      );
      this._outbox(
        `CALL_${targetState}`,
        callId,
        { callId, reason },
        timestamp
      );
      return this._mapCall(this.statements.call.get(callId));
    });
    return transaction.immediate();
  }

  sealBatch({ epoch, batchRoot, callIds, metadata = {} }) {
    const numericEpoch = Number(epoch);
    if (!Number.isSafeInteger(numericEpoch) || numericEpoch < 0) {
      throw new Error("epoch must be a non-negative safe integer");
    }
    const root = uintString(batchRoot, "batchRoot");
    if (!Array.isArray(callIds) || callIds.length < 1 || callIds.length > 16) {
      throw new Error("batch requires between 1 and 16 calls");
    }
    const canonicalCallIds = callIds.map((value) =>
      canonicalHex(value, "callId")
    );
    if (new Set(canonicalCallIds).size !== canonicalCallIds.length) {
      throw new Error("batch contains duplicate callIds");
    }
    const timestamp = this.clock();
    const transaction = this.db.transaction(() => {
      const existing = this.statements.batch.get(numericEpoch);
      if (existing) {
        const members = this.db
          .prepare(
            "SELECT call_id FROM batch_members WHERE batch_epoch = ? ORDER BY leaf_index"
          )
          .all(numericEpoch)
          .map((row) => row.call_id);
        if (
          existing.batch_root !== root ||
          JSON.stringify(members) !== JSON.stringify(canonicalCallIds)
        ) {
          throw new Error("batch epoch conflicts with sealed batch");
        }
        return { ...this._mapBatch(existing), callIds: members, idempotent: true };
      }

      const calls = canonicalCallIds.map((callId) => {
        const call = this.statements.call.get(callId);
        if (!call) throw new Error(`unknown call ${callId}`);
        if (call.state !== CALL_STATES.KEY_RELEASED) {
          throw new Error(`call ${callId} is not key released`);
        }
        return call;
      });
      this.db
        .prepare(`
          INSERT INTO batches (
            epoch, batch_root, real_count, state, metadata_json,
            created_at, updated_at
          ) VALUES (?, ?, ?, 'SEALED', ?, ?, ?)
        `)
        .run(
          numericEpoch,
          root,
          canonicalCallIds.length,
          JSON.stringify(metadata),
          timestamp,
          timestamp
        );
      const insertMember = this.db.prepare(`
        INSERT INTO batch_members (batch_epoch, call_id, leaf_index)
        VALUES (?, ?, ?)
      `);
      const updateCall = this.db.prepare(`
        UPDATE calls
        SET state = 'BATCHED', batch_epoch = ?, leaf_index = ?, updated_at = ?
        WHERE call_id = ?
      `);
      calls.forEach((call, index) => {
        insertMember.run(numericEpoch, call.call_id, index);
        updateCall.run(numericEpoch, index, timestamp, call.call_id);
        this.statements.insertTransition.run(
          call.call_id,
          call.state,
          CALL_STATES.BATCHED,
          `sealed in batch ${numericEpoch}`,
          timestamp
        );
      });
      this._outbox(
        "BATCH_SEALED",
        String(numericEpoch),
        { epoch: numericEpoch, batchRoot: root, callIds: canonicalCallIds },
        timestamp
      );
      return {
        ...this._mapBatch(this.statements.batch.get(numericEpoch)),
        callIds: canonicalCallIds,
        idempotent: false,
      };
    });
    return transaction.immediate();
  }

  markSettled(callIdValue) {
    const callId = canonicalHex(callIdValue, "callId");
    const timestamp = this.clock();
    const transaction = this.db.transaction(() => {
      const call = this.statements.call.get(callId);
      if (!call) throw new Error("unknown call");
      if (call.state === CALL_STATES.SETTLED) {
        return { ...this._mapCall(call), idempotent: true };
      }
      if (call.state !== CALL_STATES.SETTLING) {
        throw new Error(`invalid call transition ${call.state} -> SETTLED`);
      }
      const root = this.statements.root.get(call.root_commitment);
      const nextReserved = BigInt(root.reserved_amount) - BigInt(call.amount);
      const nextSettled = BigInt(root.settled_amount) + BigInt(call.amount);
      if (nextReserved < 0n || root.reserved_calls < 1) {
        throw new Error("reservation counters are inconsistent");
      }
      if (nextSettled > BigInt(root.budget)) {
        throw new Error("settled counter exceeds root budget");
      }
      this.db
        .prepare(`
          UPDATE roots
          SET reserved_amount = ?, settled_amount = ?,
              reserved_calls = reserved_calls - 1,
              settled_calls = settled_calls + 1, updated_at = ?
          WHERE root_commitment = ?
        `)
        .run(
          nextReserved.toString(),
          nextSettled.toString(),
          timestamp,
          call.root_commitment
        );
      this.db
        .prepare(
          "UPDATE calls SET state = 'SETTLED', updated_at = ? WHERE call_id = ?"
        )
        .run(timestamp, callId);
      this.statements.insertTransition.run(
        callId,
        call.state,
        CALL_STATES.SETTLED,
        "settlement receipt confirmed",
        timestamp
      );
      this._outbox(
        "CALL_SETTLED",
        callId,
        { callId, amount: call.amount },
        timestamp
      );
      return {
        ...this._mapCall(this.statements.call.get(callId)),
        idempotent: false,
      };
    });
    return transaction.immediate();
  }

  _transition(callIdValue, targetState, fields, reason) {
    const callId = canonicalHex(callIdValue, "callId");
    const timestamp = this.clock();
    const transaction = this.db.transaction(() => {
      const call = this.statements.call.get(callId);
      if (!call) throw new Error("unknown call");
      if (call.state === targetState) return this._mapCall(call);
      const allowed = FORWARD_TRANSITIONS[call.state];
      if (!allowed || !allowed.has(targetState)) {
        throw new Error(`invalid call transition ${call.state} -> ${targetState}`);
      }
      const assignments = Object.keys(fields);
      const values = Object.values(fields);
      const setClause = assignments.map((name) => `${name} = ?`).join(", ");
      this.db
        .prepare(
          `UPDATE calls SET state = ?, ${setClause}${
            setClause ? ", " : ""
          }updated_at = ? WHERE call_id = ?`
        )
        .run(targetState, ...values, timestamp, callId);
      this.statements.insertTransition.run(
        callId,
        call.state,
        targetState,
        reason,
        timestamp
      );
      this._outbox(
        `CALL_${targetState}`,
        callId,
        { callId },
        timestamp
      );
      return this._mapCall(this.statements.call.get(callId));
    });
    return transaction.immediate();
  }

  getRoot(rootCommitment) {
    const row = this.statements.root.get(
      uintString(rootCommitment, "rootCommitment")
    );
    return row ? this._mapRoot(row) : null;
  }

  getCall(callId) {
    const row = this.statements.call.get(canonicalHex(callId, "callId"));
    return row ? this._mapCall(row) : null;
  }

  getBatch(epoch) {
    const row = this.statements.batch.get(Number(epoch));
    if (!row) return null;
    const callIds = this.db
      .prepare(
        "SELECT call_id FROM batch_members WHERE batch_epoch = ? ORDER BY leaf_index"
      )
      .all(Number(epoch))
      .map((member) => member.call_id);
    return { ...this._mapBatch(row), callIds };
  }

  transitions(callId) {
    return this.db
      .prepare(
        "SELECT from_state, to_state, reason, created_at FROM call_transitions WHERE call_id = ? ORDER BY id"
      )
      .all(canonicalHex(callId, "callId"));
  }

  pendingOutbox(limit = 100) {
    return this.db
      .prepare(
        "SELECT * FROM outbox WHERE delivered_at IS NULL ORDER BY id LIMIT ?"
      )
      .all(limit)
      .map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
  }

  markOutboxDelivered(id) {
    this.db
      .prepare(
        "UPDATE outbox SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL"
      )
      .run(this.clock(), id);
  }

  assertRootInvariant(rootCommitment) {
    const root = this.getRoot(rootCommitment);
    if (!root) throw new Error("unknown root");
    const amount = root.reservedAmount + root.settledAmount;
    const calls = root.reservedCalls + root.settledCalls;
    if (amount > root.budget) throw new Error("root budget invariant violated");
    if (calls > root.maxSubcalls) {
      throw new Error("root call-count invariant violated");
    }
    return true;
  }

  _mapRoot(row) {
    return {
      rootCommitment: row.root_commitment,
      payer: row.payer,
      buyer: row.buyer,
      budget: BigInt(row.budget),
      maxSubcalls: row.max_subcalls,
      expiry: row.expiry,
      status: row.status,
      reservedAmount: BigInt(row.reserved_amount),
      settledAmount: BigInt(row.settled_amount),
      reservedCalls: row.reserved_calls,
      settledCalls: row.settled_calls,
      metadata: parseJson(row.metadata_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  _mapCall(row) {
    return {
      callId: row.call_id,
      rootCommitment: row.root_commitment,
      childIssuer: row.child_issuer,
      childNonce: row.child_nonce,
      amount: BigInt(row.amount),
      state: row.state,
      request: parseJson(row.request_json),
      providerPayload: parseJson(row.provider_payload_json),
      providerSignature: row.provider_signature,
      buyerSignature: row.buyer_signature,
      keyReveal: row.key_reveal,
      keyRevealHash: row.key_reveal_hash,
      batchEpoch: row.batch_epoch,
      leafIndex: row.leaf_index,
      settlementTransactionHash: row.settlement_tx_hash,
      failureReason: row.failure_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  _mapBatch(row) {
    return {
      epoch: row.epoch,
      batchRoot: row.batch_root,
      realCount: row.real_count,
      state: row.state,
      metadata: parseJson(row.metadata_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = {
  CALL_STATES,
  PersistentProtocolState,
};

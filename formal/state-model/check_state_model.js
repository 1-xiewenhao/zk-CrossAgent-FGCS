const fs = require("fs");
const path = require("path");

const BUDGET = 3;
const FINALITY_DEPTH = 2;
const CALL_AMOUNTS = [2, 2];
const ACTIVE_RESERVATION_STATES = new Set([
  "RESERVED",
  "RESPONSE_COMMITTED",
  "BUYER_CONFIRMED",
  "KEY_RELEASED",
  "BATCHED",
  "PROVED",
  "ROOT_RELAYED",
  "SETTLING",
]);
const CALL_RANK = Object.freeze({
  NONE: 0,
  RESERVED: 1,
  RESPONSE_COMMITTED: 2,
  BUYER_CONFIRMED: 3,
  KEY_RELEASED: 4,
  BATCHED: 5,
  PROVED: 6,
  ROOT_RELAYED: 7,
  SETTLING: 8,
  SETTLED: 9,
  EXPIRED: 9,
});

function initialState() {
  return {
    reserved: 0,
    settled: 0,
    calls: CALL_AMOUNTS.map((amount) => ({
      amount,
      phase: "NONE",
      nonceConsumed: false,
      chainSettled: false,
      paymentCount: 0,
      rpcFailureSeen: false,
      retrySeen: false,
      nonceReplaySeen: false,
    })),
    source: {
      status: "NONE",
      confirmations: 0,
      duplicateSeen: false,
      reorgSeen: false,
    },
    processUp: true,
    crashSeen: false,
    budgetRejectionSeen: false,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonical(value) {
  return JSON.stringify(value);
}

function addAction(actions, name, state, mutate) {
  const next = clone(state);
  mutate(next);
  actions.push({ name, state: next });
}

function enabledActions(state) {
  const actions = [];
  if (
    state.processUp &&
    !state.crashSeen &&
    (state.reserved > 0 ||
      state.settled > 0 ||
      state.source.status !== "NONE")
  ) {
    addAction(actions, "Crash", state, (next) => {
      next.processUp = false;
      next.crashSeen = true;
    });
  }
  if (!state.processUp) {
    addAction(actions, "Restart", state, (next) => {
      next.processUp = true;
    });
  }

  state.calls.forEach((call, index) => {
    if (state.processUp && call.phase === "NONE") {
      if (state.reserved + state.settled + call.amount <= BUDGET) {
        addAction(actions, "ReserveAccepted", state, (next) => {
          next.calls[index].phase = "RESERVED";
          next.calls[index].nonceConsumed = true;
          next.reserved += call.amount;
        });
      } else if (!state.budgetRejectionSeen) {
        addAction(actions, "ReserveRejectedBudget", state, (next) => {
          next.budgetRejectionSeen = true;
        });
      }
    }
    if (
      state.processUp &&
      call.nonceConsumed &&
      !call.nonceReplaySeen
    ) {
      addAction(actions, "ReplayNonceRejected", state, (next) => {
        next.calls[index].nonceReplaySeen = true;
      });
    }
    if (state.processUp && call.phase === "RESERVED") {
      addAction(actions, "ProviderCommit", state, (next) => {
        next.calls[index].phase = "RESPONSE_COMMITTED";
      });
      addAction(actions, "ExpireUnconfirmed", state, (next) => {
        next.calls[index].phase = "EXPIRED";
        next.reserved -= call.amount;
      });
    }
    if (state.processUp && call.phase === "RESPONSE_COMMITTED") {
      addAction(actions, "BuyerConfirm", state, (next) => {
        next.calls[index].phase = "BUYER_CONFIRMED";
      });
      addAction(actions, "ExpireUnconfirmed", state, (next) => {
        next.calls[index].phase = "EXPIRED";
        next.reserved -= call.amount;
      });
    }
    if (state.processUp && call.phase === "BUYER_CONFIRMED") {
      addAction(actions, "KeyRelease", state, (next) => {
        next.calls[index].phase = "KEY_RELEASED";
      });
    }
    if (
      state.processUp &&
      call.phase === "KEY_RELEASED" &&
      state.source.status === "NONE"
    ) {
      addAction(actions, "SealBatch", state, (next) => {
        next.calls[index].phase = "BATCHED";
      });
    }
    if (
      state.processUp &&
      call.phase === "BATCHED" &&
      state.source.status === "NONE"
    ) {
      addAction(actions, "ProofAccepted", state, (next) => {
        next.calls[index].phase = "PROVED";
      });
    }
    if (
      state.processUp &&
      call.phase === "ROOT_RELAYED" &&
      !call.rpcFailureSeen
    ) {
      addAction(actions, "RpcFailure", state, (next) => {
        next.calls[index].rpcFailureSeen = true;
      });
    }
    if (state.processUp && call.phase === "ROOT_RELAYED") {
      addAction(actions, "SubmitSettlement", state, (next) => {
        next.calls[index].phase = "SETTLING";
      });
    }
    if (call.phase === "SETTLING" && !call.chainSettled) {
      addAction(actions, "MineSettlement", state, (next) => {
        next.calls[index].chainSettled = true;
        next.calls[index].paymentCount += 1;
      });
    }
    if (
      state.processUp &&
      call.phase === "SETTLING" &&
      call.chainSettled &&
      !call.retrySeen
    ) {
      addAction(actions, "RetrySameTransaction", state, (next) => {
        next.calls[index].retrySeen = true;
      });
    }
    if (
      state.processUp &&
      call.phase === "SETTLING" &&
      call.chainSettled
    ) {
      addAction(actions, "RecordSettlement", state, (next) => {
        next.calls[index].phase = "SETTLED";
        next.reserved -= call.amount;
        next.settled += call.amount;
      });
    }
  });

  const hasProvedCall = state.calls.some(
    (call) => call.phase === "PROVED"
  );
  if (
    state.processUp &&
    hasProvedCall &&
    ["NONE", "REORGED"].includes(state.source.status)
  ) {
    addAction(actions, "ObserveSource", state, (next) => {
      next.source.status = "SEEN";
      next.source.confirmations = 0;
    });
  }
  if (
    state.processUp &&
    state.source.status === "SEEN" &&
    !state.source.duplicateSeen
  ) {
    addAction(actions, "DuplicateSourceEvent", state, (next) => {
      next.source.duplicateSeen = true;
    });
  }
  if (
    state.source.status === "SEEN" &&
    state.source.confirmations < FINALITY_DEPTH
  ) {
    addAction(actions, "AdvanceFinality", state, (next) => {
      next.source.confirmations += 1;
      if (next.source.confirmations === FINALITY_DEPTH) {
        next.source.status = "FINALIZED";
      }
    });
  }
  if (
    state.source.status === "SEEN" &&
    state.source.confirmations < FINALITY_DEPTH &&
    !state.source.reorgSeen
  ) {
    addAction(actions, "TemporaryReorg", state, (next) => {
      next.source.status = "REORGED";
      next.source.confirmations = 0;
      next.source.reorgSeen = true;
    });
  }
  if (state.processUp && state.source.status === "FINALIZED") {
    addAction(actions, "RelayFinalizedRoot", state, (next) => {
      next.source.status = "RELAYED";
      next.calls.forEach((call) => {
        if (call.phase === "PROVED") call.phase = "ROOT_RELAYED";
      });
    });
  }
  return actions;
}

function invariantViolations(state) {
  const violations = [];
  const derivedReserved = state.calls
    .filter((call) => ACTIVE_RESERVATION_STATES.has(call.phase))
    .reduce((sum, call) => sum + call.amount, 0);
  const derivedSettled = state.calls
    .filter((call) => call.phase === "SETTLED")
    .reduce((sum, call) => sum + call.amount, 0);
  if (state.reserved + state.settled > BUDGET) {
    violations.push("reserved + settled exceeds root budget");
  }
  if (state.reserved !== derivedReserved) {
    violations.push("reserved counter diverges from active obligations");
  }
  if (state.settled !== derivedSettled) {
    violations.push("settled counter diverges from settled calls");
  }
  state.calls.forEach((call, index) => {
    if (call.phase !== "NONE" && !call.nonceConsumed) {
      violations.push(`call ${index} advanced without consuming its nonce`);
    }
    if (call.paymentCount > 1) {
      violations.push(`call ${index} transferred more than once`);
    }
    if (
      call.chainSettled &&
      !["SETTLING", "SETTLED"].includes(call.phase)
    ) {
      violations.push(`call ${index} paid before settlement submission`);
    }
    if (
      call.phase === "SETTLED" &&
      (!call.chainSettled || call.paymentCount !== 1)
    ) {
      violations.push(`call ${index} recorded settlement without one payment`);
    }
    if (
      ["BUYER_CONFIRMED", "KEY_RELEASED", "BATCHED", "PROVED",
        "ROOT_RELAYED", "SETTLING", "SETTLED"].includes(call.phase) &&
      !call.nonceConsumed
    ) {
      violations.push(`call ${index} lost replay evidence`);
    }
    if (
      ["ROOT_RELAYED", "SETTLING", "SETTLED"].includes(call.phase) &&
      state.source.status !== "RELAYED"
    ) {
      violations.push(`call ${index} advanced before finalized root relay`);
    }
  });
  if (
    state.source.status === "RELAYED" &&
    state.source.confirmations < FINALITY_DEPTH
  ) {
    violations.push("root relayed before finality depth");
  }
  return violations;
}

function assertMonotonicCalls(previous, next, action) {
  previous.calls.forEach((call, index) => {
    if (CALL_RANK[next.calls[index].phase] < CALL_RANK[call.phase]) {
      throw new Error(
        `call ${index} moved backward under ${action}: ` +
          `${call.phase} -> ${next.calls[index].phase}`
      );
    }
  });
}

function explore() {
  const first = initialState();
  const firstKey = canonical(first);
  const queue = [{ state: first, depth: 0 }];
  const visited = new Set([firstKey]);
  const actionCoverage = new Map();
  let transitions = 0;
  let maximumDepth = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    maximumDepth = Math.max(maximumDepth, current.depth);
    const violations = invariantViolations(current.state);
    if (violations.length > 0) {
      throw new Error(
        `invariant violation at depth ${current.depth}: ${violations.join("; ")}`
      );
    }
    for (const transition of enabledActions(current.state)) {
      transitions += 1;
      actionCoverage.set(
        transition.name,
        (actionCoverage.get(transition.name) || 0) + 1
      );
      assertMonotonicCalls(
        current.state,
        transition.state,
        transition.name
      );
      const nextViolations = invariantViolations(transition.state);
      if (nextViolations.length > 0) {
        throw new Error(
          `invariant violation after ${transition.name}: ` +
            nextViolations.join("; ")
        );
      }
      const key = canonical(transition.state);
      if (!visited.has(key)) {
        visited.add(key);
        queue.push({ state: transition.state, depth: current.depth + 1 });
      }
    }
  }

  const requiredActions = [
    "ReserveAccepted",
    "ReserveRejectedBudget",
    "ReplayNonceRejected",
    "ProviderCommit",
    "BuyerConfirm",
    "KeyRelease",
    "SealBatch",
    "ProofAccepted",
    "ObserveSource",
    "DuplicateSourceEvent",
    "AdvanceFinality",
    "TemporaryReorg",
    "RelayFinalizedRoot",
    "RpcFailure",
    "SubmitSettlement",
    "MineSettlement",
    "RetrySameTransaction",
    "RecordSettlement",
    "Crash",
    "Restart",
    "ExpireUnconfirmed",
  ];
  const missingActions = requiredActions.filter(
    (name) => !actionCoverage.has(name)
  );
  if (missingActions.length > 0) {
    throw new Error(`model coverage missing: ${missingActions.join(", ")}`);
  }

  return {
    model: "zk-CrossAgent v2 bounded explicit-state model",
    configuration: {
      calls: CALL_AMOUNTS.length,
      callAmounts: CALL_AMOUNTS,
      rootBudget: BUDGET,
      finalityDepth: FINALITY_DEPTH,
      crashBound: 1,
      temporaryReorgBound: 1,
    },
    result: "PASS",
    statesExplored: visited.size,
    transitionsExplored: transitions,
    maximumDepth,
    invariants: [
      "reservedAmount + settledAmount <= rootBudget",
      "stored reservation counters equal active obligations",
      "call states never move backward",
      "consumed nonces are never forgotten",
      "no call transfers funds more than once",
      "settlement requires a finalized relayed root",
      "recorded settlement implies exactly one chain payment",
    ],
    actionCoverage: Object.fromEntries(
      [...actionCoverage.entries()].sort(([left], [right]) =>
        left.localeCompare(right)
      )
    ),
  };
}

const report = explore();
const evidenceDirectory = path.resolve(
  __dirname,
  "../evidence"
);
fs.mkdirSync(evidenceDirectory, { recursive: true });
fs.writeFileSync(
  path.join(evidenceDirectory, "state_model_report.json"),
  `${JSON.stringify(report, null, 2)}\n`
);
console.log(
  `PASS state model: ${report.statesExplored} states, ` +
    `${report.transitionsExplored} transitions, depth ${report.maximumDepth}`
);

const {
  PersistentProtocolState,
} = require("../../lib/v2/persistent-state");

const [databasePath, action, encodedPayload] = process.argv.slice(2);
if (!databasePath || !action || !encodedPayload) {
  throw new Error("usage: crash_worker.js DATABASE ACTION BASE64_JSON");
}
const payload = JSON.parse(
  Buffer.from(encodedPayload, "base64").toString("utf8")
);

if (action === "before-reserve") {
  process.exit(91);
}

const state = new PersistentProtocolState(databasePath);
switch (action) {
  case "reserve":
    state.reserveCall(payload);
    break;
  case "provider":
    state.recordProviderCommitment(
      payload.callId,
      payload.providerPayload,
      payload.providerSignature
    );
    break;
  case "buyer":
    state.recordBuyerConfirmation(
      payload.callId,
      payload.buyerSignature
    );
    break;
  case "key":
    state.recordKeyRelease(
      payload.callId,
      payload.keyReveal,
      payload.keyRevealHash
    );
    break;
  case "seal":
    state.sealBatch(payload);
    break;
  case "proved":
    state.markProved(payload.callId);
    break;
  case "relayed":
    state.markRootRelayed(payload.callId);
    break;
  case "settling":
    state.markSettling(payload.callId, payload.transactionHash);
    break;
  case "settled":
    state.markSettled(payload.callId);
    break;
  default:
    throw new Error(`unknown crash action ${action}`);
}

// Intentionally bypass state.close(): this is the injected process crash.
process.exit(91);

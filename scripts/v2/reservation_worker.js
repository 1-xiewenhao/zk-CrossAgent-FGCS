const {
  PersistentProtocolState,
} = require("../../lib/v2/persistent-state");

process.on("message", (message) => {
  if (message.type !== "reserve") return;
  const state = new PersistentProtocolState(message.databasePath, {
    clock: () => message.timestamp,
  });
  try {
    const call = state.reserveCall(message.request);
    process.send({ ok: true, callId: call.callId });
  } catch (error) {
    process.send({ ok: false, error: error.message });
  } finally {
    state.close();
    process.disconnect();
  }
});

process.send({ ready: true });

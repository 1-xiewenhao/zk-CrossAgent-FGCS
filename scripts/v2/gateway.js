require("dotenv").config();

const path = require("path");
const express = require("express");
const { ethers } = require("ethers");
const { buildPoseidon } = require("circomlibjs");
const {
  eip712Domain,
  settlementDomainHash,
} = require("../../lib/protocol-v2");
const {
  PersistentProtocolState,
} = require("../../lib/v2/persistent-state");
const { SecureGatewayV2 } = require("../../lib/v2/secure-gateway");

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the v2 gateway`);
  return value;
}

function publicCall(call) {
  if (!call) return null;
  return {
    callId: call.callId,
    rootCommitment: call.rootCommitment,
    amount: call.amount.toString(),
    state: call.state,
    batchEpoch: call.batchEpoch,
    leafIndex: call.leafIndex,
    settlementTransactionHash: call.settlementTransactionHash,
    failureReason: call.failureReason,
    createdAt: call.createdAt,
    updatedAt: call.updatedAt,
  };
}

function createGatewayApp({ gateway, state }) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_request, response) => {
    response.json({ ok: true, protocolVersion: 2 });
  });

  app.post("/v2/roots", (request, response, next) => {
    try {
      const root = gateway.registerRoot(
        request.body.root,
        request.body.issuerSignature
      );
      response.status(root.idempotent ? 200 : 201).json({
        rootCommitment: root.rootCommitment,
        status: root.status,
        idempotent: root.idempotent,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v2/calls", (request, response, next) => {
    try {
      const call = gateway.reserveAuthorizedCall(request.body);
      response.status(call.idempotent ? 200 : 201).json({
        ...publicCall(call),
        idempotent: call.idempotent,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v2/calls/:callId/commit", async (request, response, next) => {
    try {
      const committed = await gateway.commitEncryptedResponse(
        request.params.callId,
        request.body.response
      );
      response.json(committed);
    } catch (error) {
      next(error);
    }
  });

  app.post("/v2/calls/:callId/confirm", async (request, response, next) => {
    try {
      const released = await gateway.confirmAndRelease(
        request.params.callId,
        request.body.buyerSignature
      );
      response.json(released);
    } catch (error) {
      next(error);
    }
  });

  app.post("/v2/calls/:callId/release", (request, response, next) => {
    try {
      response.json(gateway.releaseConfirmedKey(request.params.callId));
    } catch (error) {
      next(error);
    }
  });

  app.get("/v2/calls/:callId", (request, response, next) => {
    try {
      const call = state.getCall(request.params.callId);
      if (!call) return response.status(404).json({ error: "unknown call" });
      return response.json(publicCall(call));
    } catch (error) {
      return next(error);
    }
  });

  app.use((error, _request, response, _next) => {
    response.status(400).json({ error: error.message });
  });
  return app;
}

async function main() {
  const settlementChainId = Number(
    requiredEnvironment("SETTLEMENT_CHAIN_ID")
  );
  const serviceChainId = Number(requiredEnvironment("SERVICE_CHAIN_ID"));
  const settlementContract = requiredEnvironment("ESCROW_ADDRESS");
  const serviceRegistry = requiredEnvironment("CAP_MANAGER_ADDRESS");
  const databasePath =
    process.env.GATEWAY_V2_DB_PATH ||
    path.resolve(process.cwd(), "runtime/gateway-v2.sqlite");
  const providerSigner = new ethers.Wallet(
    requiredEnvironment("GATEWAY_PRIVATE_KEY")
  );
  const state = new PersistentProtocolState(databasePath);
  const poseidon = await buildPoseidon();
  const domain = eip712Domain(settlementChainId, settlementContract);
  const domainHash = settlementDomainHash({
    serviceChainId,
    serviceRegistry,
    settlementChainId,
    settlementContract,
  });
  const gateway = new SecureGatewayV2({
    state,
    poseidon,
    eip712Domain: domain,
    settlementDomainHash: domainHash,
    providerSigner,
    masterKey: requiredEnvironment("GATEWAY_MASTER_KEY"),
  });
  const app = createGatewayApp({ gateway, state });
  const port = Number(process.env.GATEWAY_PORT || 3000);
  const server = app.listen(port, () => {
    console.log(`zk-CrossAgent v2 gateway listening on ${port}`);
    console.log(`provider=${providerSigner.address}`);
    console.log(`database=${databasePath}`);
  });
  const shutdown = () => {
    server.close(() => {
      state.checkpoint();
      state.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  createGatewayApp,
  publicCall,
};

const crypto = require("crypto");
const { ethers } = require("ethers");
const { canonicalize } = require("json-canonicalize");
const {
  PROTOCOL_VERSION,
  ROOT_CAPABILITY_TYPES,
  CHILD_CAPABILITY_TYPES,
  RECEIPT_TYPES,
  CALLER_CONFIRMATION_TYPES,
  rootCapabilityTypedValue,
  childCapabilityTypedValue,
  computeCallId,
  computeRootCapabilityCommitment,
  computeChildCapabilityCommitment,
  computeReceiptCommitment,
  callerConfirmation,
} = require("../protocol-v2");
const { CALL_STATES } = require("./persistent-state");
const { validateDeliveryEnvelope } = require("./delivery-validation");

function bytes(value, label) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new Error(`${label} must be a string, Buffer, or Uint8Array`);
}

function hex(buffer) {
  return ethers.utils.hexlify(buffer);
}

function hashBytes(buffer) {
  return ethers.utils.keccak256(buffer);
}

function sameAddress(left, right) {
  return ethers.utils.getAddress(left) === ethers.utils.getAddress(right);
}

function sameHex(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function jsonSafe(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item
    )
  );
}

function parseMasterKey(masterKey) {
  const value =
    typeof masterKey === "string"
      ? Buffer.from(ethers.utils.arrayify(masterKey))
      : bytes(masterKey, "masterKey");
  if (value.length !== 32) {
    throw new Error("masterKey must contain exactly 32 bytes");
  }
  return value;
}

function associatedData(metadata) {
  return Buffer.from(canonicalize(jsonSafe(metadata)), "utf8");
}

function encryptAead(key, plaintext, aad) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { nonce, authTag, ciphertext };
}

function decryptAead(key, encrypted, aad) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    encrypted.nonce
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(encrypted.authTag);
  return Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final(),
  ]);
}

function sealKey(masterKey, callId, key) {
  const aad = Buffer.from(callId.toLowerCase(), "utf8");
  const encrypted = encryptAead(masterKey, key, aad);
  return {
    nonce: hex(encrypted.nonce),
    authTag: hex(encrypted.authTag),
    ciphertext: hex(encrypted.ciphertext),
  };
}

function unsealKey(masterKey, callId, sealed) {
  return decryptAead(
    masterKey,
    {
      nonce: Buffer.from(ethers.utils.arrayify(sealed.nonce)),
      authTag: Buffer.from(ethers.utils.arrayify(sealed.authTag)),
      ciphertext: Buffer.from(ethers.utils.arrayify(sealed.ciphertext)),
    },
    Buffer.from(callId.toLowerCase(), "utf8")
  );
}

function encryptDelivery({ response, associatedDataValue }) {
  const plaintext = bytes(response, "response");
  const key = crypto.randomBytes(32);
  const aad = associatedData(associatedDataValue);
  const encrypted = encryptAead(key, plaintext, aad);
  const committedCiphertext = Buffer.concat([
    encrypted.nonce,
    encrypted.authTag,
    encrypted.ciphertext,
  ]);
  return {
    key,
    envelope: {
      algorithm: "AES-256-GCM",
      nonce: hex(encrypted.nonce),
      authTag: hex(encrypted.authTag),
      ciphertext: hex(encrypted.ciphertext),
      associatedData: jsonSafe(associatedDataValue),
    },
    responseHash: hashBytes(plaintext),
    ciphertextHash: hashBytes(committedCiphertext),
    keyCommitment: hashBytes(key),
  };
}

function decryptDelivery({ envelope, keyReveal, receipt }) {
  const key = Buffer.from(ethers.utils.arrayify(keyReveal));
  if (key.length !== 32) throw new Error("key reveal must contain 32 bytes");
  if (!sameHex(hashBytes(key), receipt.delivery.keyCommitment)) {
    throw new Error("key reveal does not match receipt commitment");
  }
  const encrypted = validateDeliveryEnvelope(envelope, receipt);
  const plaintext = decryptAead(
    key,
    encrypted,
    associatedData(envelope.associatedData)
  );
  if (!sameHex(hashBytes(plaintext), receipt.delivery.responseHash)) {
    throw new Error("plaintext does not match receipt commitment");
  }
  return plaintext;
}

class SecureGatewayV2 {
  constructor({
    state,
    poseidon,
    eip712Domain,
    settlementDomainHash,
    providerSigner,
    masterKey,
    clock = () => Math.floor(Date.now() / 1000),
  }) {
    if (!state || !poseidon || !eip712Domain || !providerSigner) {
      throw new Error("state, poseidon, eip712Domain, and providerSigner are required");
    }
    this.state = state;
    this.poseidon = poseidon;
    this.domain = eip712Domain;
    this.settlementDomainHash = settlementDomainHash;
    this.providerSigner = providerSigner;
    this.masterKey = parseMasterKey(masterKey);
    this.clock = clock;
  }

  registerRoot(root, issuerSignature) {
    this._assertVersionAndDomain(root);
    if (!sameAddress(root.issuer, root.payer)) {
      throw new Error("root issuer must equal payer");
    }
    const commitment = computeRootCapabilityCommitment(this.poseidon, root);
    if (commitment !== BigInt(root.capabilityCommitment)) {
      throw new Error("root capability commitment mismatch");
    }
    const signer = ethers.utils.verifyTypedData(
      this.domain,
      ROOT_CAPABILITY_TYPES,
      rootCapabilityTypedValue(root),
      issuerSignature
    );
    if (!sameAddress(signer, root.issuer)) {
      throw new Error("invalid root issuer signature");
    }
    return this.state.registerRoot({
      rootCommitment: root.capabilityCommitment,
      payer: root.payer,
      buyer: root.buyer,
      budget: root.budget,
      maxSubcalls: root.maxSubcalls,
      expiry: root.expiry,
      metadata: { root: jsonSafe(root), issuerSignature },
    });
  }

  reserveAuthorizedCall({
    root,
    child,
    childSignature,
    request,
    providerAmount,
    orchestratorFee,
    orchestrator,
  }) {
    this._assertVersionAndDomain(root);
    this._assertVersionAndDomain(child);
    const rootCommitment = computeRootCapabilityCommitment(
      this.poseidon,
      root
    );
    const childCommitment = computeChildCapabilityCommitment(
      this.poseidon,
      child
    );
    if (rootCommitment !== BigInt(root.capabilityCommitment)) {
      throw new Error("root capability commitment mismatch");
    }
    if (childCommitment !== BigInt(child.capabilityCommitment)) {
      throw new Error("child capability commitment mismatch");
    }
    this._assertAttenuation(root, child);
    if (!sameAddress(child.provider, this.providerSigner.address)) {
      throw new Error("child provider does not identify this gateway");
    }
    const childSigner = ethers.utils.verifyTypedData(
      this.domain,
      CHILD_CAPABILITY_TYPES,
      childCapabilityTypedValue(child),
      childSignature
    );
    if (!sameAddress(childSigner, child.buyer)) {
      throw new Error("invalid child buyer signature");
    }

    const providerValue = BigInt(providerAmount);
    const feeValue = BigInt(orchestratorFee);
    if (providerValue < 1n || feeValue < 0n) {
      throw new Error("invalid call amounts");
    }
    if (providerValue > BigInt(child.budget)) {
      throw new Error("provider amount exceeds child budget");
    }
    const totalAmount = providerValue + feeValue;
    if (totalAmount > BigInt(root.budget)) {
      throw new Error("call amount exceeds root budget");
    }
    const canonicalRequest = Buffer.from(canonicalize(request), "utf8");
    const requestHash = hashBytes(canonicalRequest);
    const callId = computeCallId({
      settlementDomainHash: this.settlementDomainHash,
      taskId: root.taskId,
      childCapabilityCommitment: child.capabilityCommitment,
      childNonce: child.nonce,
    });
    return this.state.reserveCall({
      callId,
      rootCommitment: root.capabilityCommitment,
      childIssuer: child.issuer,
      childNonce: child.nonce,
      childExpiry: child.expiry,
      amount: totalAmount,
      metadata: {
        protocolVersion: PROTOCOL_VERSION,
        root: jsonSafe(root),
        child: jsonSafe(child),
        childSignature,
        request: jsonSafe(request),
        requestHash,
        providerAmount: providerValue.toString(),
        orchestratorFee: feeValue.toString(),
        orchestrator: ethers.utils.getAddress(orchestrator),
      },
    });
  }

  async commitEncryptedResponse(callId, response) {
    const call = this.state.getCall(callId);
    if (!call) throw new Error("unknown call");
    if (call.state !== CALL_STATES.RESERVED) {
      throw new Error("call must be RESERVED before provider commitment");
    }
    const { root, child } = call.request;
    const aadValue = {
      protocolVersion: PROTOCOL_VERSION,
      callId: call.callId,
      taskId: root.taskId,
      requestHash: call.request.requestHash,
      provider: child.provider,
      buyer: root.buyer,
      settlementDomainHash: this.settlementDomainHash,
    };
    const delivery = encryptDelivery({
      response,
      associatedDataValue: aadValue,
    });
    const receipt = {
      protocolVersion: PROTOCOL_VERSION,
      identity: {
        callId: call.callId,
        taskId: root.taskId,
        rootCommitment: root.capabilityCommitment,
        childCommitment: child.capabilityCommitment,
        payer: root.payer,
        buyer: root.buyer,
        orchestrator: call.request.orchestrator,
        provider: child.provider,
      },
      delivery: {
        requestHash: call.request.requestHash,
        responseHash: delivery.responseHash,
        ciphertextHash: delivery.ciphertextHash,
        keyCommitment: delivery.keyCommitment,
      },
      economics: {
        providerAmount: call.request.providerAmount,
        orchestratorFee: call.request.orchestratorFee,
        createdAt: this.clock(),
        settlementDomainHash: this.settlementDomainHash,
      },
      receiptCommitment: "0",
    };
    this._enforceReceiptDeadline(call, receipt);
    receipt.receiptCommitment = computeReceiptCommitment(
      this.poseidon,
      receipt
    ).toString();
    const providerSignature = await this.providerSigner._signTypedData(
      this.domain,
      RECEIPT_TYPES,
      receipt
    );
    this.state.recordProviderCommitment(
      call.callId,
      {
        receipt,
        envelope: delivery.envelope,
        sealedKey: sealKey(this.masterKey, call.callId, delivery.key),
      },
      providerSignature
    );
    return {
      receipt,
      envelope: delivery.envelope,
      providerSignature,
    };
  }

  async confirmAndRelease(callId, buyerSignature) {
    let call = this.state.getCall(callId);
    if (!call) throw new Error("unknown call");
    if (call.state === CALL_STATES.KEY_RELEASED) {
      return this._releasedDelivery(call);
    }
    if (call.state !== CALL_STATES.RESPONSE_COMMITTED) {
      throw new Error("call must be RESPONSE_COMMITTED before confirmation");
    }
    const { receipt } = call.providerPayload;
    this._enforceReceiptDeadline(call, receipt);
    this._verifyReceiptSignatures(
      receipt,
      call.providerSignature,
      buyerSignature
    );
    this.state.recordBuyerConfirmation(call.callId, buyerSignature);
    call = this.state.getCall(call.callId);
    return this.releaseConfirmedKey(call.callId);
  }

  releaseConfirmedKey(callId) {
    let call = this.state.getCall(callId);
    if (!call) throw new Error("unknown call");
    if (call.state === CALL_STATES.KEY_RELEASED) {
      return this._releasedDelivery(call);
    }
    if (call.state !== CALL_STATES.BUYER_CONFIRMED) {
      throw new Error("call must be BUYER_CONFIRMED before key release");
    }
    const { receipt, sealedKey } = call.providerPayload;
    this._enforceReceiptDeadline(call, receipt);
    const key = unsealKey(this.masterKey, call.callId, sealedKey);
    const keyReveal = hex(key);
    const keyRevealHash = hashBytes(key);
    if (!sameHex(keyRevealHash, receipt.delivery.keyCommitment)) {
      throw new Error("unsealed key does not match receipt commitment");
    }
    this.state.recordKeyRelease(call.callId, keyReveal, keyRevealHash);
    call = this.state.getCall(call.callId);
    return this._releasedDelivery(call);
  }

  _releasedDelivery(call) {
    this._enforceReceiptDeadline(call, call.providerPayload.receipt);
    return {
      receipt: call.providerPayload.receipt,
      envelope: call.providerPayload.envelope,
      providerSignature: call.providerSignature,
      buyerSignature: call.buyerSignature,
      keyReveal: call.keyReveal,
    };
  }

  _enforceReceiptDeadline(call, receipt) {
    const { root, child } = call.request;
    const createdAt = BigInt(receipt.economics.createdAt);
    if (
      createdAt >= 0n &&
      createdAt <= BigInt(child.expiry) &&
      BigInt(child.expiry) <= BigInt(root.expiry)
    ) {
      return;
    }

    // Validate the signed receipt time, not the time of confirmation or settlement.
    // Invalid receipts must not release a key or retain a pre-release reservation.
    const reason = "receipt timestamp exceeds capability expiry";
    if ([CALL_STATES.RESERVED, CALL_STATES.RESPONSE_COMMITTED].includes(call.state)) {
      this.state.expireUnconfirmed(call.callId, reason);
    } else if (call.state === CALL_STATES.BUYER_CONFIRMED) {
      this.state.failMissingKey(call.callId, reason);
    }
    // Never refund a historical KEY_RELEASED call: disclosure cannot be undone.
    throw new Error(reason);
  }

  _verifyReceiptSignatures(receipt, providerSignature, buyerSignature) {
    const provider = ethers.utils.verifyTypedData(
      this.domain,
      RECEIPT_TYPES,
      receipt,
      providerSignature
    );
    if (!sameAddress(provider, receipt.identity.provider)) {
      throw new Error("invalid provider receipt signature");
    }
    const confirmation = callerConfirmation(receipt, providerSignature);
    const buyer = ethers.utils.verifyTypedData(
      this.domain,
      CALLER_CONFIRMATION_TYPES,
      confirmation,
      buyerSignature
    );
    if (!sameAddress(buyer, receipt.identity.buyer)) {
      throw new Error("invalid buyer confirmation signature");
    }
  }

  _assertVersionAndDomain(capability) {
    if (Number(capability.protocolVersion) !== PROTOCOL_VERSION) {
      throw new Error("unsupported protocol version");
    }
    if (
      !sameHex(
        capability.settlementDomainHash,
        this.settlementDomainHash
      )
    ) {
      throw new Error("settlement domain mismatch");
    }
  }

  _assertAttenuation(root, child) {
    if (
      !sameAddress(child.issuer, root.issuer) ||
      !sameAddress(child.buyer, root.buyer) ||
      BigInt(child.parentCommitment) !== BigInt(root.capabilityCommitment) ||
      !sameHex(child.taskId, root.taskId) ||
      !sameHex(child.scopeHash, root.scopeHash)
    ) {
      throw new Error("child capability is not bound to root");
    }
    if (BigInt(child.maxSubcalls) < 1n) {
      throw new Error("child call limit must be positive");
    }
    const rootPermissions = BigInt(root.permissions);
    const childPermissions = BigInt(child.permissions);
    if ((childPermissions & rootPermissions) !== childPermissions) {
      throw new Error("child permissions exceed root permissions");
    }
    if (
      BigInt(child.budget) > BigInt(root.budget) ||
      BigInt(child.expiry) > BigInt(root.expiry) ||
      BigInt(child.maxSubcalls) > BigInt(root.maxSubcalls)
    ) {
      throw new Error("child capability exceeds root limits");
    }
  }
}

module.exports = {
  SecureGatewayV2,
  decryptDelivery,
  encryptDelivery,
};

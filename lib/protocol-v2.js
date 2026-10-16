const { ethers } = require("ethers");

const PROTOCOL_VERSION = 2;
const SNARK_FIELD = ethers.BigNumber.from(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);
const TAGS = Object.freeze({
  ROOT_AUTHORITY: 1101n,
  ROOT_LIMITS: 1102n,
  ROOT_CONTEXT: 1103n,
  ROOT_CAPABILITY: 1104n,
  CHILD_AUTHORITY: 1201n,
  CHILD_LIMITS: 1202n,
  CHILD_CONTEXT: 1203n,
  CHILD_CAPABILITY: 1204n,
  IDENTITY: 1001n,
  IDENTITY_CONT: 1002n,
  IDENTITY_FINAL: 1003n,
  DELIVERY: 1010n,
  DELIVERY_FINAL: 1011n,
  ECONOMICS: 1020n,
  RECEIPT: 1030n,
  REAL_LEAF: 1040n,
  DUMMY_LEAF: 1041n,
});

const ROOT_CAPABILITY_TYPES = {
  RootAuthorityV2: [
    { name: "issuer", type: "address" },
    { name: "payer", type: "address" },
    { name: "buyer", type: "address" },
    { name: "taskId", type: "bytes32" },
  ],
  RootLimitsV2: [
    { name: "permissions", type: "uint64" },
    { name: "budget", type: "uint64" },
    { name: "expiry", type: "uint64" },
    { name: "maxSubcalls", type: "uint32" },
    { name: "nonce", type: "uint64" },
    { name: "scopeHash", type: "bytes32" },
  ],
  RootCapabilityV2: [
    { name: "protocolVersion", type: "uint16" },
    { name: "authority", type: "RootAuthorityV2" },
    { name: "limits", type: "RootLimitsV2" },
    { name: "settlementDomainHash", type: "bytes32" },
    { name: "capabilityCommitment", type: "uint256" },
  ],
};

const CHILD_CAPABILITY_TYPES = {
  ChildAuthorityV2: [
    { name: "issuer", type: "address" },
    { name: "buyer", type: "address" },
    { name: "provider", type: "address" },
    { name: "parentCommitment", type: "uint256" },
    { name: "taskId", type: "bytes32" },
  ],
  ChildLimitsV2: [
    { name: "permissions", type: "uint64" },
    { name: "budget", type: "uint64" },
    { name: "expiry", type: "uint64" },
    { name: "maxSubcalls", type: "uint32" },
    { name: "nonce", type: "uint64" },
    { name: "scopeHash", type: "bytes32" },
  ],
  ChildCapabilityV2: [
    { name: "protocolVersion", type: "uint16" },
    { name: "authority", type: "ChildAuthorityV2" },
    { name: "limits", type: "ChildLimitsV2" },
    { name: "settlementDomainHash", type: "bytes32" },
    { name: "capabilityCommitment", type: "uint256" },
  ],
};

function rootCapabilityTypedValue(root) {
  return {
    protocolVersion: root.protocolVersion,
    authority: {
      issuer: root.issuer,
      payer: root.payer,
      buyer: root.buyer,
      taskId: root.taskId,
    },
    limits: {
      permissions: root.permissions,
      budget: root.budget,
      expiry: root.expiry,
      maxSubcalls: root.maxSubcalls,
      nonce: root.nonce,
      scopeHash: root.scopeHash,
    },
    settlementDomainHash: root.settlementDomainHash,
    capabilityCommitment: root.capabilityCommitment,
  };
}

function childCapabilityTypedValue(child) {
  return {
    protocolVersion: child.protocolVersion,
    authority: {
      issuer: child.issuer,
      buyer: child.buyer,
      provider: child.provider,
      parentCommitment: child.parentCommitment,
      taskId: child.taskId,
    },
    limits: {
      permissions: child.permissions,
      budget: child.budget,
      expiry: child.expiry,
      maxSubcalls: child.maxSubcalls,
      nonce: child.nonce,
      scopeHash: child.scopeHash,
    },
    settlementDomainHash: child.settlementDomainHash,
    capabilityCommitment: child.capabilityCommitment,
  };
}

const RECEIPT_TYPES = {
  ReceiptIdentityV2: [
    { name: "callId", type: "bytes32" },
    { name: "taskId", type: "bytes32" },
    { name: "rootCommitment", type: "uint256" },
    { name: "childCommitment", type: "uint256" },
    { name: "payer", type: "address" },
    { name: "buyer", type: "address" },
    { name: "orchestrator", type: "address" },
    { name: "provider", type: "address" },
  ],
  DeliveryCommitmentV2: [
    { name: "requestHash", type: "bytes32" },
    { name: "responseHash", type: "bytes32" },
    { name: "ciphertextHash", type: "bytes32" },
    { name: "keyCommitment", type: "bytes32" },
  ],
  ReceiptEconomicsV2: [
    { name: "providerAmount", type: "uint64" },
    { name: "orchestratorFee", type: "uint64" },
    { name: "createdAt", type: "uint64" },
    { name: "settlementDomainHash", type: "bytes32" },
  ],
  ReceiptCoreV2: [
    { name: "protocolVersion", type: "uint16" },
    { name: "identity", type: "ReceiptIdentityV2" },
    { name: "delivery", type: "DeliveryCommitmentV2" },
    { name: "economics", type: "ReceiptEconomicsV2" },
    { name: "receiptCommitment", type: "uint256" },
  ],
};

const CALLER_CONFIRMATION_TYPES = {
  CallerConfirmationV2: [
    { name: "protocolVersion", type: "uint16" },
    { name: "callId", type: "bytes32" },
    { name: "receiptCommitment", type: "uint256" },
    { name: "providerSignatureHash", type: "bytes32" },
    { name: "settlementDomainHash", type: "bytes32" },
  ],
};

function eip712Domain(chainId, verifyingContract) {
  return {
    name: "zk-CrossAgent Settlement",
    version: "2",
    chainId,
    verifyingContract,
  };
}

function settlementDomainHash({
  serviceChainId,
  serviceRegistry,
  settlementChainId,
  settlementContract,
}) {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["uint16", "uint64", "address", "uint64", "address"],
      [
        PROTOCOL_VERSION,
        serviceChainId,
        serviceRegistry,
        settlementChainId,
        settlementContract,
      ]
    )
  );
}

function computeCallId({
  protocolVersion = PROTOCOL_VERSION,
  settlementDomainHash: domainHash,
  taskId,
  childCapabilityCommitment,
  childNonce,
}) {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["uint16", "bytes32", "bytes32", "uint256", "uint64"],
      [
        protocolVersion,
        domainHash,
        taskId,
        childCapabilityCommitment,
        childNonce,
      ]
    )
  );
}

function splitBytes32(value) {
  const numeric = BigInt(value);
  const mask = (1n << 128n) - 1n;
  return [numeric >> 128n, numeric & mask];
}

function addressField(address) {
  return BigInt(ethers.utils.getAddress(address));
}

function poseidonValue(poseidon, inputs) {
  const value = poseidon(inputs.map((input) => BigInt(input)));
  return BigInt(poseidon.F.toString(value));
}

function computeReceiptCommitment(poseidon, receipt) {
  const [callHi, callLo] = splitBytes32(receipt.identity.callId);
  const [taskHi, taskLo] = splitBytes32(receipt.identity.taskId);
  const [requestHi, requestLo] = splitBytes32(receipt.delivery.requestHash);
  const [responseHi, responseLo] = splitBytes32(receipt.delivery.responseHash);
  const [ciphertextHi, ciphertextLo] = splitBytes32(
    receipt.delivery.ciphertextHash
  );
  const [keyHi, keyLo] = splitBytes32(receipt.delivery.keyCommitment);
  const [domainHi, domainLo] = splitBytes32(
    receipt.economics.settlementDomainHash
  );

  const identityFirst = poseidonValue(poseidon, [
    TAGS.IDENTITY,
    callHi,
    callLo,
    taskHi,
    taskLo,
    receipt.identity.rootCommitment,
  ]);
  const identitySecond = poseidonValue(poseidon, [
    TAGS.IDENTITY_CONT,
    identityFirst,
    receipt.identity.childCommitment,
    addressField(receipt.identity.payer),
    addressField(receipt.identity.buyer),
    addressField(receipt.identity.orchestrator),
  ]);
  const identityCommitment = poseidonValue(poseidon, [
    TAGS.IDENTITY_FINAL,
    identitySecond,
    addressField(receipt.identity.provider),
    0,
    0,
    0,
  ]);
  const deliveryFirst = poseidonValue(poseidon, [
    TAGS.DELIVERY,
    requestHi,
    requestLo,
    responseHi,
    responseLo,
    ciphertextHi,
  ]);
  const deliveryCommitment = poseidonValue(poseidon, [
    TAGS.DELIVERY_FINAL,
    deliveryFirst,
    ciphertextLo,
    keyHi,
    keyLo,
    0,
  ]);
  const economicsCommitment = poseidonValue(poseidon, [
    TAGS.ECONOMICS,
    receipt.protocolVersion,
    domainHi,
    domainLo,
    receipt.economics.providerAmount,
    receipt.economics.orchestratorFee,
  ]);
  return poseidonValue(poseidon, [
    TAGS.RECEIPT,
    identityCommitment,
    deliveryCommitment,
    economicsCommitment,
    receipt.economics.createdAt,
    0,
  ]);
}

function computeRootCapabilityCommitment(poseidon, root) {
  const [taskHi, taskLo] = splitBytes32(root.taskId);
  const [scopeHi, scopeLo] = splitBytes32(root.scopeHash);
  const [domainHi, domainLo] = splitBytes32(root.settlementDomainHash);

  const authority = poseidonValue(poseidon, [
    TAGS.ROOT_AUTHORITY,
    addressField(root.issuer),
    addressField(root.payer),
    addressField(root.buyer),
    taskHi,
    taskLo,
  ]);
  const limits = poseidonValue(poseidon, [
    TAGS.ROOT_LIMITS,
    root.permissions,
    root.budget,
    root.expiry,
    root.maxSubcalls,
    root.nonce,
  ]);
  const context = poseidonValue(poseidon, [
    TAGS.ROOT_CONTEXT,
    authority,
    limits,
    scopeHi,
    scopeLo,
    domainHi,
  ]);
  return poseidonValue(poseidon, [
    TAGS.ROOT_CAPABILITY,
    context,
    domainLo,
    root.protocolVersion,
    0,
    0,
  ]);
}

function computeChildCapabilityCommitment(poseidon, child) {
  const [taskHi, taskLo] = splitBytes32(child.taskId);
  const [scopeHi, scopeLo] = splitBytes32(child.scopeHash);
  const [domainHi, domainLo] = splitBytes32(child.settlementDomainHash);

  const authority = poseidonValue(poseidon, [
    TAGS.CHILD_AUTHORITY,
    addressField(child.issuer),
    addressField(child.buyer),
    addressField(child.provider),
    child.parentCommitment,
    taskHi,
  ]);
  const limits = poseidonValue(poseidon, [
    TAGS.CHILD_LIMITS,
    taskLo,
    child.permissions,
    child.budget,
    child.expiry,
    child.maxSubcalls,
  ]);
  const context = poseidonValue(poseidon, [
    TAGS.CHILD_CONTEXT,
    authority,
    limits,
    child.nonce,
    scopeHi,
    scopeLo,
  ]);
  return poseidonValue(poseidon, [
    TAGS.CHILD_CAPABILITY,
    context,
    domainHi,
    domainLo,
    child.protocolVersion,
    0,
  ]);
}

function computeRealLeaf(poseidon, receiptCommitment) {
  return poseidonValue(poseidon, [
    receiptCommitment,
    TAGS.REAL_LEAF,
  ]);
}

function computeDummyLeaf(poseidon) {
  return poseidonValue(poseidon, [0, TAGS.DUMMY_LEAF]);
}

function buildMerkleTree(poseidon, realLeaves, capacity = 16) {
  if (capacity < 1 || (capacity & (capacity - 1)) !== 0) {
    throw new Error("capacity must be a positive power of two");
  }
  if (realLeaves.length < 1 || realLeaves.length > capacity) {
    throw new Error("real leaf count is outside capacity");
  }

  const leaves = realLeaves.map(BigInt);
  const dummy = computeDummyLeaf(poseidon);
  while (leaves.length < capacity) leaves.push(dummy);

  const layers = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const prior = layers[layers.length - 1];
    const next = [];
    for (let index = 0; index < prior.length; index += 2) {
      next.push(poseidonValue(poseidon, [prior[index], prior[index + 1]]));
    }
    layers.push(next);
  }

  return {
    root: layers[layers.length - 1][0],
    leaves,
    proof(index) {
      if (index < 0 || index >= realLeaves.length) {
        throw new Error("proof index must identify a real leaf");
      }
      const siblings = [];
      let cursor = index;
      for (let layer = 0; layer < layers.length - 1; layer += 1) {
        siblings.push(layers[layer][cursor ^ 1]);
        cursor = Math.floor(cursor / 2);
      }
      return siblings;
    },
  };
}

function buildCircuitInput(
  poseidon,
  items,
  { settlementDomainHash: domainHash, batchEpoch, capacity = 16 } = {}
) {
  if (!Array.isArray(items) || items.length < 1 || items.length > capacity) {
    throw new Error("items must contain between one and capacity real entries");
  }
  if (capacity !== 16) {
    throw new Error("the compiled v2 circuit requires capacity 16");
  }
  if (domainHash === undefined || batchEpoch === undefined) {
    throw new Error("settlementDomainHash and batchEpoch are required");
  }

  const [domainHi, domainLo] = splitBytes32(domainHash);
  const arrayNames = [
    "rootIssuer",
    "rootPayer",
    "rootBuyer",
    "rootTaskHi",
    "rootTaskLo",
    "rootPermissions",
    "rootBudget",
    "rootExpiry",
    "rootMaxSubcalls",
    "rootNonce",
    "rootScopeHi",
    "rootScopeLo",
    "rootCommitment",
    "childIssuer",
    "childBuyer",
    "childProvider",
    "childParentCommitment",
    "childTaskHi",
    "childTaskLo",
    "childPermissions",
    "childBudget",
    "childExpiry",
    "childMaxSubcalls",
    "childNonce",
    "childScopeHi",
    "childScopeLo",
    "childCommitment",
    "callHi",
    "callLo",
    "receiptTaskHi",
    "receiptTaskLo",
    "receiptRootCommitment",
    "receiptChildCommitment",
    "receiptPayer",
    "receiptBuyer",
    "receiptOrchestrator",
    "receiptProvider",
    "requestHi",
    "requestLo",
    "responseHi",
    "responseLo",
    "ciphertextHi",
    "ciphertextLo",
    "keyHi",
    "keyLo",
    "providerAmount",
    "orchestratorFee",
    "createdAt",
    "receiptCommitment",
    "isDummy",
  ];
  const input = Object.fromEntries(arrayNames.map((name) => [name, []]));
  Object.assign(input, {
    protocolVersion: String(PROTOCOL_VERSION),
    domainHi: domainHi.toString(),
    domainLo: domainLo.toString(),
    batchEpoch: BigInt(batchEpoch).toString(),
    realCount: String(items.length),
  });

  const push = (name, value) => input[name].push(BigInt(value).toString());
  const pushSplit = (highName, lowName, value) => {
    const [high, low] = splitBytes32(value);
    push(highName, high);
    push(lowName, low);
  };

  const receiptCommitments = [];
  for (const { root, child, receipt } of items) {
    if (!root || !child || !receipt) {
      throw new Error("each circuit item requires root, child, and receipt");
    }
    const rootCommitment = computeRootCapabilityCommitment(poseidon, root);
    const childCommitment = computeChildCapabilityCommitment(poseidon, child);
    const receiptCommitment = computeReceiptCommitment(poseidon, receipt);
    receiptCommitments.push(receiptCommitment);

    push("rootIssuer", addressField(root.issuer));
    push("rootPayer", addressField(root.payer));
    push("rootBuyer", addressField(root.buyer));
    pushSplit("rootTaskHi", "rootTaskLo", root.taskId);
    push("rootPermissions", root.permissions);
    push("rootBudget", root.budget);
    push("rootExpiry", root.expiry);
    push("rootMaxSubcalls", root.maxSubcalls);
    push("rootNonce", root.nonce);
    pushSplit("rootScopeHi", "rootScopeLo", root.scopeHash);
    push("rootCommitment", rootCommitment);

    push("childIssuer", addressField(child.issuer));
    push("childBuyer", addressField(child.buyer));
    push("childProvider", addressField(child.provider));
    push("childParentCommitment", child.parentCommitment);
    pushSplit("childTaskHi", "childTaskLo", child.taskId);
    push("childPermissions", child.permissions);
    push("childBudget", child.budget);
    push("childExpiry", child.expiry);
    push("childMaxSubcalls", child.maxSubcalls);
    push("childNonce", child.nonce);
    pushSplit("childScopeHi", "childScopeLo", child.scopeHash);
    push("childCommitment", childCommitment);

    pushSplit("callHi", "callLo", receipt.identity.callId);
    pushSplit("receiptTaskHi", "receiptTaskLo", receipt.identity.taskId);
    push("receiptRootCommitment", receipt.identity.rootCommitment);
    push("receiptChildCommitment", receipt.identity.childCommitment);
    push("receiptPayer", addressField(receipt.identity.payer));
    push("receiptBuyer", addressField(receipt.identity.buyer));
    push(
      "receiptOrchestrator",
      addressField(receipt.identity.orchestrator)
    );
    push("receiptProvider", addressField(receipt.identity.provider));
    pushSplit("requestHi", "requestLo", receipt.delivery.requestHash);
    pushSplit("responseHi", "responseLo", receipt.delivery.responseHash);
    pushSplit(
      "ciphertextHi",
      "ciphertextLo",
      receipt.delivery.ciphertextHash
    );
    pushSplit("keyHi", "keyLo", receipt.delivery.keyCommitment);
    push("providerAmount", receipt.economics.providerAmount);
    push("orchestratorFee", receipt.economics.orchestratorFee);
    push("createdAt", receipt.economics.createdAt);
    push("receiptCommitment", receiptCommitment);
    push("isDummy", 0);
  }

  while (input.isDummy.length < capacity) {
    for (const name of arrayNames) {
      push(name, name === "isDummy" ? 1 : 0);
    }
  }

  const leaves = receiptCommitments.map((commitment) =>
    computeRealLeaf(poseidon, commitment)
  );
  const tree = buildMerkleTree(poseidon, leaves, capacity);
  return { input, expectedBatchRoot: tree.root, tree };
}

function callerConfirmation(receipt, providerSignature) {
  return {
    protocolVersion: receipt.protocolVersion,
    callId: receipt.identity.callId,
    receiptCommitment: receipt.receiptCommitment,
    providerSignatureHash: ethers.utils.keccak256(providerSignature),
    settlementDomainHash: receipt.economics.settlementDomainHash,
  };
}

module.exports = {
  PROTOCOL_VERSION,
  SNARK_FIELD,
  TAGS,
  ROOT_CAPABILITY_TYPES,
  CHILD_CAPABILITY_TYPES,
  RECEIPT_TYPES,
  CALLER_CONFIRMATION_TYPES,
  eip712Domain,
  rootCapabilityTypedValue,
  childCapabilityTypedValue,
  settlementDomainHash,
  computeCallId,
  splitBytes32,
  addressField,
  poseidonValue,
  computeReceiptCommitment,
  computeRootCapabilityCommitment,
  computeChildCapabilityCommitment,
  computeRealLeaf,
  computeDummyLeaf,
  buildMerkleTree,
  buildCircuitInput,
  callerConfirmation,
};

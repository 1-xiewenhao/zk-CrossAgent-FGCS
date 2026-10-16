pragma circom 2.2.0;

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/comparators.circom";
include "../../node_modules/circomlib/circuits/bitify.circom";

template RootCapabilityCommitmentV2() {
    signal input protocolVersion;
    signal input issuer;
    signal input payer;
    signal input buyer;
    signal input taskHi;
    signal input taskLo;
    signal input permissions;
    signal input budget;
    signal input expiry;
    signal input maxSubcalls;
    signal input nonce;
    signal input scopeHi;
    signal input scopeLo;
    signal input domainHi;
    signal input domainLo;
    signal output commitment;

    component authority = Poseidon(6);
    authority.inputs[0] <== 1101;
    authority.inputs[1] <== issuer;
    authority.inputs[2] <== payer;
    authority.inputs[3] <== buyer;
    authority.inputs[4] <== taskHi;
    authority.inputs[5] <== taskLo;

    component limits = Poseidon(6);
    limits.inputs[0] <== 1102;
    limits.inputs[1] <== permissions;
    limits.inputs[2] <== budget;
    limits.inputs[3] <== expiry;
    limits.inputs[4] <== maxSubcalls;
    limits.inputs[5] <== nonce;

    component context = Poseidon(6);
    context.inputs[0] <== 1103;
    context.inputs[1] <== authority.out;
    context.inputs[2] <== limits.out;
    context.inputs[3] <== scopeHi;
    context.inputs[4] <== scopeLo;
    context.inputs[5] <== domainHi;

    component finalHasher = Poseidon(6);
    finalHasher.inputs[0] <== 1104;
    finalHasher.inputs[1] <== context.out;
    finalHasher.inputs[2] <== domainLo;
    finalHasher.inputs[3] <== protocolVersion;
    finalHasher.inputs[4] <== 0;
    finalHasher.inputs[5] <== 0;
    commitment <== finalHasher.out;
}

template ChildCapabilityCommitmentV2() {
    signal input protocolVersion;
    signal input issuer;
    signal input buyer;
    signal input provider;
    signal input parentCommitment;
    signal input taskHi;
    signal input taskLo;
    signal input permissions;
    signal input budget;
    signal input expiry;
    signal input maxSubcalls;
    signal input nonce;
    signal input scopeHi;
    signal input scopeLo;
    signal input domainHi;
    signal input domainLo;
    signal output commitment;

    component authority = Poseidon(6);
    authority.inputs[0] <== 1201;
    authority.inputs[1] <== issuer;
    authority.inputs[2] <== buyer;
    authority.inputs[3] <== provider;
    authority.inputs[4] <== parentCommitment;
    authority.inputs[5] <== taskHi;

    component limits = Poseidon(6);
    limits.inputs[0] <== 1202;
    limits.inputs[1] <== taskLo;
    limits.inputs[2] <== permissions;
    limits.inputs[3] <== budget;
    limits.inputs[4] <== expiry;
    limits.inputs[5] <== maxSubcalls;

    component context = Poseidon(6);
    context.inputs[0] <== 1203;
    context.inputs[1] <== authority.out;
    context.inputs[2] <== limits.out;
    context.inputs[3] <== nonce;
    context.inputs[4] <== scopeHi;
    context.inputs[5] <== scopeLo;

    component finalHasher = Poseidon(6);
    finalHasher.inputs[0] <== 1204;
    finalHasher.inputs[1] <== context.out;
    finalHasher.inputs[2] <== domainHi;
    finalHasher.inputs[3] <== domainLo;
    finalHasher.inputs[4] <== protocolVersion;
    finalHasher.inputs[5] <== 0;
    commitment <== finalHasher.out;
}

template ReceiptCommitmentV2() {
    signal input protocolVersion;
    signal input callHi;
    signal input callLo;
    signal input taskHi;
    signal input taskLo;
    signal input rootCommitment;
    signal input childCommitment;
    signal input payer;
    signal input buyer;
    signal input orchestrator;
    signal input provider;
    signal input requestHi;
    signal input requestLo;
    signal input responseHi;
    signal input responseLo;
    signal input ciphertextHi;
    signal input ciphertextLo;
    signal input keyHi;
    signal input keyLo;
    signal input providerAmount;
    signal input orchestratorFee;
    signal input createdAt;
    signal input domainHi;
    signal input domainLo;
    signal output commitment;

    component identityFirst = Poseidon(6);
    identityFirst.inputs[0] <== 1001;
    identityFirst.inputs[1] <== callHi;
    identityFirst.inputs[2] <== callLo;
    identityFirst.inputs[3] <== taskHi;
    identityFirst.inputs[4] <== taskLo;
    identityFirst.inputs[5] <== rootCommitment;

    component identitySecond = Poseidon(6);
    identitySecond.inputs[0] <== 1002;
    identitySecond.inputs[1] <== identityFirst.out;
    identitySecond.inputs[2] <== childCommitment;
    identitySecond.inputs[3] <== payer;
    identitySecond.inputs[4] <== buyer;
    identitySecond.inputs[5] <== orchestrator;

    component identityFinal = Poseidon(6);
    identityFinal.inputs[0] <== 1003;
    identityFinal.inputs[1] <== identitySecond.out;
    identityFinal.inputs[2] <== provider;
    identityFinal.inputs[3] <== 0;
    identityFinal.inputs[4] <== 0;
    identityFinal.inputs[5] <== 0;

    component deliveryFirst = Poseidon(6);
    deliveryFirst.inputs[0] <== 1010;
    deliveryFirst.inputs[1] <== requestHi;
    deliveryFirst.inputs[2] <== requestLo;
    deliveryFirst.inputs[3] <== responseHi;
    deliveryFirst.inputs[4] <== responseLo;
    deliveryFirst.inputs[5] <== ciphertextHi;

    component deliveryFinal = Poseidon(6);
    deliveryFinal.inputs[0] <== 1011;
    deliveryFinal.inputs[1] <== deliveryFirst.out;
    deliveryFinal.inputs[2] <== ciphertextLo;
    deliveryFinal.inputs[3] <== keyHi;
    deliveryFinal.inputs[4] <== keyLo;
    deliveryFinal.inputs[5] <== 0;

    component economics = Poseidon(6);
    economics.inputs[0] <== 1020;
    economics.inputs[1] <== protocolVersion;
    economics.inputs[2] <== domainHi;
    economics.inputs[3] <== domainLo;
    economics.inputs[4] <== providerAmount;
    economics.inputs[5] <== orchestratorFee;

    component finalHasher = Poseidon(6);
    finalHasher.inputs[0] <== 1030;
    finalHasher.inputs[1] <== identityFinal.out;
    finalHasher.inputs[2] <== deliveryFinal.out;
    finalHasher.inputs[3] <== economics.out;
    finalHasher.inputs[4] <== createdAt;
    finalHasher.inputs[5] <== 0;
    commitment <== finalHasher.out;
}

template BatchLeafV2() {
    signal input protocolVersion;
    signal input domainHi;
    signal input domainLo;

    signal input rootIssuer;
    signal input rootPayer;
    signal input rootBuyer;
    signal input rootTaskHi;
    signal input rootTaskLo;
    signal input rootPermissions;
    signal input rootBudget;
    signal input rootExpiry;
    signal input rootMaxSubcalls;
    signal input rootNonce;
    signal input rootScopeHi;
    signal input rootScopeLo;
    signal input rootCommitment;

    signal input childIssuer;
    signal input childBuyer;
    signal input childProvider;
    signal input childParentCommitment;
    signal input childTaskHi;
    signal input childTaskLo;
    signal input childPermissions;
    signal input childBudget;
    signal input childExpiry;
    signal input childMaxSubcalls;
    signal input childNonce;
    signal input childScopeHi;
    signal input childScopeLo;
    signal input childCommitment;

    signal input callHi;
    signal input callLo;
    signal input receiptTaskHi;
    signal input receiptTaskLo;
    signal input receiptRootCommitment;
    signal input receiptChildCommitment;
    signal input receiptPayer;
    signal input receiptBuyer;
    signal input receiptOrchestrator;
    signal input receiptProvider;
    signal input requestHi;
    signal input requestLo;
    signal input responseHi;
    signal input responseLo;
    signal input ciphertextHi;
    signal input ciphertextLo;
    signal input keyHi;
    signal input keyLo;
    signal input providerAmount;
    signal input orchestratorFee;
    signal input createdAt;
    signal input receiptCommitment;
    signal input isDummy;

    signal output leaf;
    signal output real;

    isDummy * (isDummy - 1) === 0;
    real <== 1 - isDummy;

    component rootHasher = RootCapabilityCommitmentV2();
    rootHasher.protocolVersion <== protocolVersion;
    rootHasher.issuer <== rootIssuer;
    rootHasher.payer <== rootPayer;
    rootHasher.buyer <== rootBuyer;
    rootHasher.taskHi <== rootTaskHi;
    rootHasher.taskLo <== rootTaskLo;
    rootHasher.permissions <== rootPermissions;
    rootHasher.budget <== rootBudget;
    rootHasher.expiry <== rootExpiry;
    rootHasher.maxSubcalls <== rootMaxSubcalls;
    rootHasher.nonce <== rootNonce;
    rootHasher.scopeHi <== rootScopeHi;
    rootHasher.scopeLo <== rootScopeLo;
    rootHasher.domainHi <== domainHi;
    rootHasher.domainLo <== domainLo;

    component childHasher = ChildCapabilityCommitmentV2();
    childHasher.protocolVersion <== protocolVersion;
    childHasher.issuer <== childIssuer;
    childHasher.buyer <== childBuyer;
    childHasher.provider <== childProvider;
    childHasher.parentCommitment <== childParentCommitment;
    childHasher.taskHi <== childTaskHi;
    childHasher.taskLo <== childTaskLo;
    childHasher.permissions <== childPermissions;
    childHasher.budget <== childBudget;
    childHasher.expiry <== childExpiry;
    childHasher.maxSubcalls <== childMaxSubcalls;
    childHasher.nonce <== childNonce;
    childHasher.scopeHi <== childScopeHi;
    childHasher.scopeLo <== childScopeLo;
    childHasher.domainHi <== domainHi;
    childHasher.domainLo <== domainLo;

    component receiptHasher = ReceiptCommitmentV2();
    receiptHasher.protocolVersion <== protocolVersion;
    receiptHasher.callHi <== callHi;
    receiptHasher.callLo <== callLo;
    receiptHasher.taskHi <== receiptTaskHi;
    receiptHasher.taskLo <== receiptTaskLo;
    receiptHasher.rootCommitment <== receiptRootCommitment;
    receiptHasher.childCommitment <== receiptChildCommitment;
    receiptHasher.payer <== receiptPayer;
    receiptHasher.buyer <== receiptBuyer;
    receiptHasher.orchestrator <== receiptOrchestrator;
    receiptHasher.provider <== receiptProvider;
    receiptHasher.requestHi <== requestHi;
    receiptHasher.requestLo <== requestLo;
    receiptHasher.responseHi <== responseHi;
    receiptHasher.responseLo <== responseLo;
    receiptHasher.ciphertextHi <== ciphertextHi;
    receiptHasher.ciphertextLo <== ciphertextLo;
    receiptHasher.keyHi <== keyHi;
    receiptHasher.keyLo <== keyLo;
    receiptHasher.providerAmount <== providerAmount;
    receiptHasher.orchestratorFee <== orchestratorFee;
    receiptHasher.createdAt <== createdAt;
    receiptHasher.domainHi <== domainHi;
    receiptHasher.domainLo <== domainLo;

    (rootHasher.commitment - rootCommitment) * real === 0;
    (childHasher.commitment - childCommitment) * real === 0;
    (receiptHasher.commitment - receiptCommitment) * real === 0;

    (rootIssuer - rootPayer) * real === 0;
    (childIssuer - rootIssuer) * real === 0;
    (childBuyer - rootBuyer) * real === 0;
    (childParentCommitment - rootCommitment) * real === 0;
    (childTaskHi - rootTaskHi) * real === 0;
    (childTaskLo - rootTaskLo) * real === 0;
    (childScopeHi - rootScopeHi) * real === 0;
    (childScopeLo - rootScopeLo) * real === 0;

    (receiptTaskHi - rootTaskHi) * real === 0;
    (receiptTaskLo - rootTaskLo) * real === 0;
    (receiptRootCommitment - rootCommitment) * real === 0;
    (receiptChildCommitment - childCommitment) * real === 0;
    (receiptPayer - rootPayer) * real === 0;
    (receiptBuyer - rootBuyer) * real === 0;
    (receiptProvider - childProvider) * real === 0;

    rootCommitment * isDummy === 0;
    childCommitment * isDummy === 0;
    receiptCommitment * isDummy === 0;

    component addressBits[10];
    addressBits[0] = Num2Bits(160); addressBits[0].in <== rootIssuer;
    addressBits[1] = Num2Bits(160); addressBits[1].in <== rootPayer;
    addressBits[2] = Num2Bits(160); addressBits[2].in <== rootBuyer;
    addressBits[3] = Num2Bits(160); addressBits[3].in <== childIssuer;
    addressBits[4] = Num2Bits(160); addressBits[4].in <== childBuyer;
    addressBits[5] = Num2Bits(160); addressBits[5].in <== childProvider;
    addressBits[6] = Num2Bits(160); addressBits[6].in <== receiptPayer;
    addressBits[7] = Num2Bits(160); addressBits[7].in <== receiptBuyer;
    addressBits[8] = Num2Bits(160); addressBits[8].in <== receiptOrchestrator;
    addressBits[9] = Num2Bits(160); addressBits[9].in <== receiptProvider;

    component limbBits[20];
    limbBits[0] = Num2Bits(128); limbBits[0].in <== rootTaskHi;
    limbBits[1] = Num2Bits(128); limbBits[1].in <== rootTaskLo;
    limbBits[2] = Num2Bits(128); limbBits[2].in <== rootScopeHi;
    limbBits[3] = Num2Bits(128); limbBits[3].in <== rootScopeLo;
    limbBits[4] = Num2Bits(128); limbBits[4].in <== childTaskHi;
    limbBits[5] = Num2Bits(128); limbBits[5].in <== childTaskLo;
    limbBits[6] = Num2Bits(128); limbBits[6].in <== childScopeHi;
    limbBits[7] = Num2Bits(128); limbBits[7].in <== childScopeLo;
    limbBits[8] = Num2Bits(128); limbBits[8].in <== callHi;
    limbBits[9] = Num2Bits(128); limbBits[9].in <== callLo;
    limbBits[10] = Num2Bits(128); limbBits[10].in <== receiptTaskHi;
    limbBits[11] = Num2Bits(128); limbBits[11].in <== receiptTaskLo;
    limbBits[12] = Num2Bits(128); limbBits[12].in <== requestHi;
    limbBits[13] = Num2Bits(128); limbBits[13].in <== requestLo;
    limbBits[14] = Num2Bits(128); limbBits[14].in <== responseHi;
    limbBits[15] = Num2Bits(128); limbBits[15].in <== responseLo;
    limbBits[16] = Num2Bits(128); limbBits[16].in <== ciphertextHi;
    limbBits[17] = Num2Bits(128); limbBits[17].in <== ciphertextLo;
    limbBits[18] = Num2Bits(128); limbBits[18].in <== keyHi;
    limbBits[19] = Num2Bits(128); limbBits[19].in <== keyLo;

    component rootPermissionBits = Num2Bits(64);
    component childPermissionBits = Num2Bits(64);
    rootPermissionBits.in <== rootPermissions;
    childPermissionBits.in <== childPermissions;
    for (var bit = 0; bit < 64; bit++) {
        childPermissionBits.out[bit] * (1 - rootPermissionBits.out[bit]) === 0;
    }

    component u64Bits[9];
    u64Bits[0] = Num2Bits(64); u64Bits[0].in <== rootBudget;
    u64Bits[1] = Num2Bits(64); u64Bits[1].in <== rootExpiry;
    u64Bits[2] = Num2Bits(64); u64Bits[2].in <== rootNonce;
    u64Bits[3] = Num2Bits(64); u64Bits[3].in <== childBudget;
    u64Bits[4] = Num2Bits(64); u64Bits[4].in <== childExpiry;
    u64Bits[5] = Num2Bits(64); u64Bits[5].in <== childNonce;
    u64Bits[6] = Num2Bits(64); u64Bits[6].in <== providerAmount;
    u64Bits[7] = Num2Bits(64); u64Bits[7].in <== orchestratorFee;
    u64Bits[8] = Num2Bits(64); u64Bits[8].in <== createdAt;

    component rootMaxBits = Num2Bits(32);
    component childMaxBits = Num2Bits(32);
    rootMaxBits.in <== rootMaxSubcalls;
    childMaxBits.in <== childMaxSubcalls;

    component budgetAttenuation = LessEqThan(64);
    budgetAttenuation.in[0] <== childBudget;
    budgetAttenuation.in[1] <== rootBudget;
    (budgetAttenuation.out - 1) * real === 0;

    component expiryAttenuation = LessEqThan(64);
    expiryAttenuation.in[0] <== childExpiry;
    expiryAttenuation.in[1] <== rootExpiry;
    (expiryAttenuation.out - 1) * real === 0;

    component callAttenuation = LessEqThan(32);
    callAttenuation.in[0] <== childMaxSubcalls;
    callAttenuation.in[1] <== rootMaxSubcalls;
    (callAttenuation.out - 1) * real === 0;

    component providerBudget = LessEqThan(64);
    providerBudget.in[0] <== providerAmount;
    providerBudget.in[1] <== childBudget;
    (providerBudget.out - 1) * real === 0;

    signal totalAmount;
    totalAmount <== providerAmount + orchestratorFee;
    component totalBits = Num2Bits(65);
    totalBits.in <== totalAmount;
    component totalBudget = LessEqThan(65);
    totalBudget.in[0] <== totalAmount;
    totalBudget.in[1] <== rootBudget;
    (totalBudget.out - 1) * real === 0;

    component createdBeforeChildExpiry = LessEqThan(64);
    createdBeforeChildExpiry.in[0] <== createdAt;
    createdBeforeChildExpiry.in[1] <== childExpiry;
    (createdBeforeChildExpiry.out - 1) * real === 0;

    component providerZero = IsZero();
    component orchestratorZero = IsZero();
    component rootCommitmentZero = IsZero();
    component childCommitmentZero = IsZero();
    component childMaxZero = IsZero();
    providerZero.in <== receiptProvider;
    orchestratorZero.in <== receiptOrchestrator;
    rootCommitmentZero.in <== rootCommitment;
    childCommitmentZero.in <== childCommitment;
    childMaxZero.in <== childMaxSubcalls;
    providerZero.out * real === 0;
    orchestratorZero.out * real === 0;
    rootCommitmentZero.out * real === 0;
    childCommitmentZero.out * real === 0;
    childMaxZero.out * real === 0;

    signal leafTag;
    leafTag <== 1040 * real + 1041 * isDummy;
    component leafHasher = Poseidon(2);
    leafHasher.inputs[0] <== receiptCommitment * real;
    leafHasher.inputs[1] <== leafTag;
    leaf <== leafHasher.out;
}

template ZkCrossAgentBatchV2(N) {
    signal input protocolVersion;
    signal input domainHi;
    signal input domainLo;
    signal input batchEpoch;
    signal input realCount;

    signal input rootIssuer[N];
    signal input rootPayer[N];
    signal input rootBuyer[N];
    signal input rootTaskHi[N];
    signal input rootTaskLo[N];
    signal input rootPermissions[N];
    signal input rootBudget[N];
    signal input rootExpiry[N];
    signal input rootMaxSubcalls[N];
    signal input rootNonce[N];
    signal input rootScopeHi[N];
    signal input rootScopeLo[N];
    signal input rootCommitment[N];

    signal input childIssuer[N];
    signal input childBuyer[N];
    signal input childProvider[N];
    signal input childParentCommitment[N];
    signal input childTaskHi[N];
    signal input childTaskLo[N];
    signal input childPermissions[N];
    signal input childBudget[N];
    signal input childExpiry[N];
    signal input childMaxSubcalls[N];
    signal input childNonce[N];
    signal input childScopeHi[N];
    signal input childScopeLo[N];
    signal input childCommitment[N];

    signal input callHi[N];
    signal input callLo[N];
    signal input receiptTaskHi[N];
    signal input receiptTaskLo[N];
    signal input receiptRootCommitment[N];
    signal input receiptChildCommitment[N];
    signal input receiptPayer[N];
    signal input receiptBuyer[N];
    signal input receiptOrchestrator[N];
    signal input receiptProvider[N];
    signal input requestHi[N];
    signal input requestLo[N];
    signal input responseHi[N];
    signal input responseLo[N];
    signal input ciphertextHi[N];
    signal input ciphertextLo[N];
    signal input keyHi[N];
    signal input keyLo[N];
    signal input providerAmount[N];
    signal input orchestratorFee[N];
    signal input createdAt[N];
    signal input receiptCommitment[N];
    signal input isDummy[N];

    signal output batchRoot;

    protocolVersion === 2;
    component domainRange[2];
    domainRange[0] = Num2Bits(128); domainRange[0].in <== domainHi;
    domainRange[1] = Num2Bits(128); domainRange[1].in <== domainLo;
    component epochRange = Num2Bits(64);
    epochRange.in <== batchEpoch;
    component countRange = Num2Bits(8);
    countRange.in <== realCount;

    component leaves[N];
    signal prefixReal[N + 1];
    prefixReal[0] <== 0;

    for (var i = 0; i < N; i++) {
        leaves[i] = BatchLeafV2();
        leaves[i].protocolVersion <== protocolVersion;
        leaves[i].domainHi <== domainHi;
        leaves[i].domainLo <== domainLo;

        leaves[i].rootIssuer <== rootIssuer[i];
        leaves[i].rootPayer <== rootPayer[i];
        leaves[i].rootBuyer <== rootBuyer[i];
        leaves[i].rootTaskHi <== rootTaskHi[i];
        leaves[i].rootTaskLo <== rootTaskLo[i];
        leaves[i].rootPermissions <== rootPermissions[i];
        leaves[i].rootBudget <== rootBudget[i];
        leaves[i].rootExpiry <== rootExpiry[i];
        leaves[i].rootMaxSubcalls <== rootMaxSubcalls[i];
        leaves[i].rootNonce <== rootNonce[i];
        leaves[i].rootScopeHi <== rootScopeHi[i];
        leaves[i].rootScopeLo <== rootScopeLo[i];
        leaves[i].rootCommitment <== rootCommitment[i];

        leaves[i].childIssuer <== childIssuer[i];
        leaves[i].childBuyer <== childBuyer[i];
        leaves[i].childProvider <== childProvider[i];
        leaves[i].childParentCommitment <== childParentCommitment[i];
        leaves[i].childTaskHi <== childTaskHi[i];
        leaves[i].childTaskLo <== childTaskLo[i];
        leaves[i].childPermissions <== childPermissions[i];
        leaves[i].childBudget <== childBudget[i];
        leaves[i].childExpiry <== childExpiry[i];
        leaves[i].childMaxSubcalls <== childMaxSubcalls[i];
        leaves[i].childNonce <== childNonce[i];
        leaves[i].childScopeHi <== childScopeHi[i];
        leaves[i].childScopeLo <== childScopeLo[i];
        leaves[i].childCommitment <== childCommitment[i];

        leaves[i].callHi <== callHi[i];
        leaves[i].callLo <== callLo[i];
        leaves[i].receiptTaskHi <== receiptTaskHi[i];
        leaves[i].receiptTaskLo <== receiptTaskLo[i];
        leaves[i].receiptRootCommitment <== receiptRootCommitment[i];
        leaves[i].receiptChildCommitment <== receiptChildCommitment[i];
        leaves[i].receiptPayer <== receiptPayer[i];
        leaves[i].receiptBuyer <== receiptBuyer[i];
        leaves[i].receiptOrchestrator <== receiptOrchestrator[i];
        leaves[i].receiptProvider <== receiptProvider[i];
        leaves[i].requestHi <== requestHi[i];
        leaves[i].requestLo <== requestLo[i];
        leaves[i].responseHi <== responseHi[i];
        leaves[i].responseLo <== responseLo[i];
        leaves[i].ciphertextHi <== ciphertextHi[i];
        leaves[i].ciphertextLo <== ciphertextLo[i];
        leaves[i].keyHi <== keyHi[i];
        leaves[i].keyLo <== keyLo[i];
        leaves[i].providerAmount <== providerAmount[i];
        leaves[i].orchestratorFee <== orchestratorFee[i];
        leaves[i].createdAt <== createdAt[i];
        leaves[i].receiptCommitment <== receiptCommitment[i];
        leaves[i].isDummy <== isDummy[i];

        prefixReal[i + 1] <== prefixReal[i] + leaves[i].real;
    }

    for (var j = 0; j < N - 1; j++) {
        isDummy[j] * (1 - isDummy[j + 1]) === 0;
    }
    prefixReal[N] === realCount;

    component level1[N / 2];
    component level2[N / 4];
    component level3[N / 8];
    component level4 = Poseidon(2);

    for (var a = 0; a < N / 2; a++) {
        level1[a] = Poseidon(2);
        level1[a].inputs[0] <== leaves[2 * a].leaf;
        level1[a].inputs[1] <== leaves[2 * a + 1].leaf;
    }
    for (var b = 0; b < N / 4; b++) {
        level2[b] = Poseidon(2);
        level2[b].inputs[0] <== level1[2 * b].out;
        level2[b].inputs[1] <== level1[2 * b + 1].out;
    }
    for (var c = 0; c < N / 8; c++) {
        level3[c] = Poseidon(2);
        level3[c].inputs[0] <== level2[2 * c].out;
        level3[c].inputs[1] <== level2[2 * c + 1].out;
    }
    level4.inputs[0] <== level3[0].out;
    level4.inputs[1] <== level3[1].out;
    batchRoot <== level4.out;
}

component main {public [protocolVersion, domainHi, domainLo, batchEpoch, realCount]} =
    ZkCrossAgentBatchV2(16);

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

library ZkCrossAgentTypes {
    struct RootCapability {
        uint16 protocolVersion;
        address issuer;
        address payer;
        address buyer;
        bytes32 taskId;
        uint64 permissions;
        uint64 budget;
        uint64 expiry;
        uint32 maxSubcalls;
        uint64 nonce;
        bytes32 scopeHash;
        bytes32 settlementDomainHash;
        uint256 capabilityCommitment;
    }

    struct ReceiptIdentity {
        bytes32 callId;
        bytes32 taskId;
        uint256 rootCommitment;
        uint256 childCommitment;
        address payer;
        address buyer;
        address orchestrator;
        address provider;
    }

    struct DeliveryCommitment {
        bytes32 requestHash;
        bytes32 responseHash;
        bytes32 ciphertextHash;
        bytes32 keyCommitment;
    }

    struct ReceiptEconomics {
        uint64 providerAmount;
        uint64 orchestratorFee;
        uint64 createdAt;
        bytes32 settlementDomainHash;
    }

    struct ReceiptCore {
        uint16 protocolVersion;
        ReceiptIdentity identity;
        DeliveryCommitment delivery;
        ReceiptEconomics economics;
        uint256 receiptCommitment;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "./ZkCrossAgentTypes.sol";

abstract contract RootCapabilityRegistryV2 is EIP712 {
    using ECDSA for bytes32;

    uint16 public constant PROTOCOL_VERSION = 2;
    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    bytes32 private constant ROOT_AUTHORITY_TYPEHASH =
        keccak256(
            "RootAuthorityV2(address issuer,address payer,address buyer,bytes32 taskId)"
        );
    bytes32 private constant ROOT_LIMITS_TYPEHASH =
        keccak256(
            "RootLimitsV2(uint64 permissions,uint64 budget,uint64 expiry,uint32 maxSubcalls,uint64 nonce,bytes32 scopeHash)"
        );
    bytes32 private constant ROOT_CAPABILITY_TYPEHASH =
        keccak256(
            "RootCapabilityV2(uint16 protocolVersion,RootAuthorityV2 authority,RootLimitsV2 limits,bytes32 settlementDomainHash,uint256 capabilityCommitment)RootAuthorityV2(address issuer,address payer,address buyer,bytes32 taskId)RootLimitsV2(uint64 permissions,uint64 budget,uint64 expiry,uint32 maxSubcalls,uint64 nonce,bytes32 scopeHash)"
        );

    struct RootRecord {
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
        uint64 settledAmount;
        uint32 settledCalls;
        bool exists;
    }

    bytes32 public immutable settlementDomainHash;
    mapping(uint256 => RootRecord) internal rootRecords;

    event RootCapabilityRegistered(
        uint256 indexed capabilityCommitment,
        bytes32 indexed taskId,
        address indexed payer,
        address buyer,
        uint64 budget,
        uint32 maxSubcalls,
        uint64 expiry
    );

    constructor(bytes32 _settlementDomainHash)
        EIP712("zk-CrossAgent Settlement", "2")
    {
        require(_settlementDomainHash != bytes32(0), "RootV2: zero domain");
        settlementDomainHash = _settlementDomainHash;
    }

    function registerRootCapability(
        ZkCrossAgentTypes.RootCapability calldata root,
        bytes calldata issuerSignature
    ) external {
        require(
            root.protocolVersion == PROTOCOL_VERSION,
            "RootV2: wrong version"
        );
        require(root.issuer != address(0), "RootV2: zero issuer");
        require(root.payer == root.issuer, "RootV2: issuer must be payer");
        require(root.buyer != address(0), "RootV2: zero buyer");
        require(root.taskId != bytes32(0), "RootV2: zero task");
        require(root.budget > 0, "RootV2: zero budget");
        require(root.maxSubcalls > 0, "RootV2: zero max calls");
        require(root.expiry > block.timestamp, "RootV2: expired");
        require(
            root.settlementDomainHash == settlementDomainHash,
            "RootV2: wrong domain"
        );
        require(
            root.capabilityCommitment > 0 &&
                root.capabilityCommitment < SNARK_SCALAR_FIELD,
            "RootV2: invalid commitment"
        );
        require(
            !rootRecords[root.capabilityCommitment].exists,
            "RootV2: already registered"
        );

        bytes32 authorityHash = keccak256(
            abi.encode(
                ROOT_AUTHORITY_TYPEHASH,
                root.issuer,
                root.payer,
                root.buyer,
                root.taskId
            )
        );
        bytes32 limitsHash = keccak256(
            abi.encode(
                ROOT_LIMITS_TYPEHASH,
                root.permissions,
                root.budget,
                root.expiry,
                root.maxSubcalls,
                root.nonce,
                root.scopeHash
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                ROOT_CAPABILITY_TYPEHASH,
                root.protocolVersion,
                authorityHash,
                limitsHash,
                root.settlementDomainHash,
                root.capabilityCommitment
            )
        );
        address recovered = _hashTypedDataV4(structHash).recover(
            issuerSignature
        );
        require(recovered == root.issuer, "RootV2: invalid issuer signature");

        rootRecords[root.capabilityCommitment] = RootRecord({
            issuer: root.issuer,
            payer: root.payer,
            buyer: root.buyer,
            taskId: root.taskId,
            permissions: root.permissions,
            budget: root.budget,
            expiry: root.expiry,
            maxSubcalls: root.maxSubcalls,
            nonce: root.nonce,
            scopeHash: root.scopeHash,
            settledAmount: 0,
            settledCalls: 0,
            exists: true
        });

        _afterRootRegistered(root.capabilityCommitment);

        emit RootCapabilityRegistered(
            root.capabilityCommitment,
            root.taskId,
            root.payer,
            root.buyer,
            root.budget,
            root.maxSubcalls,
            root.expiry
        );
    }

    function _afterRootRegistered(uint256 capabilityCommitment) internal virtual {}

    function getRootRecord(
        uint256 capabilityCommitment
    ) external view returns (RootRecord memory) {
        return rootRecords[capabilityCommitment];
    }

    function _consumeRootBudget(
        uint256 capabilityCommitment,
        uint64 amount
    ) internal {
        RootRecord storage root = rootRecords[capabilityCommitment];
        require(root.exists, "RootV2: unknown root");
        require(
            uint256(root.settledAmount) + amount <= root.budget,
            "RootV2: budget exceeded"
        );
        require(
            uint256(root.settledCalls) + 1 <= root.maxSubcalls,
            "RootV2: call limit exceeded"
        );

        root.settledAmount += amount;
        root.settledCalls += 1;
    }
}

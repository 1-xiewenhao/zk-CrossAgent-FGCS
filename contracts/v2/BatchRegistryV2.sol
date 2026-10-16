// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IZkCrossAgentBatchVerifierV2 {
    function verifyProof(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[6] calldata publicSignals
    ) external view returns (bool);
}

contract BatchRegistryV2 {
    uint16 public constant PROTOCOL_VERSION = 2;
    uint16 public constant BATCH_CAPACITY = 16;
    uint256 private constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    struct RegisteredBatch {
        uint64 epoch;
        uint16 realCount;
        uint256 batchRoot;
        uint64 sourceBlockNumber;
        bool exists;
    }

    IZkCrossAgentBatchVerifierV2 public immutable verifier;
    bytes32 public immutable settlementDomainHash;
    uint64 public immutable settlementChainId;
    address public immutable settlementContract;
    mapping(bytes32 => RegisteredBatch) private batches;

    event BatchProofRegistered(
        bytes32 indexed batchKey,
        uint64 indexed epoch,
        uint256 indexed batchRoot,
        uint16 realCount
    );

    constructor(
        address verifierAddress,
        bytes32 domainHash,
        uint64 destinationChainId,
        address destinationContract
    ) {
        require(verifierAddress != address(0), "RegistryV2: zero verifier");
        require(domainHash != bytes32(0), "RegistryV2: zero domain");
        require(destinationChainId > 0, "RegistryV2: zero destination chain");
        require(destinationContract != address(0), "RegistryV2: zero destination");
        verifier = IZkCrossAgentBatchVerifierV2(verifierAddress);
        settlementDomainHash = domainHash;
        settlementChainId = destinationChainId;
        settlementContract = destinationContract;
    }

    function computeBatchKey(
        uint64 epoch,
        uint256 batchRoot
    ) public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    PROTOCOL_VERSION,
                    block.chainid,
                    address(this),
                    settlementChainId,
                    settlementContract,
                    epoch,
                    batchRoot
                )
            );
    }

    function registerBatchProof(
        uint64 epoch,
        uint16 realCount,
        uint256 batchRoot,
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC
    ) external returns (bytes32 batchKey) {
        require(realCount > 0 && realCount <= BATCH_CAPACITY, "RegistryV2: invalid count");
        require(
            batchRoot > 0 && batchRoot < SNARK_SCALAR_FIELD,
            "RegistryV2: invalid root"
        );
        batchKey = computeBatchKey(epoch, batchRoot);
        require(!batches[batchKey].exists, "RegistryV2: duplicate batch");

        (uint256 domainHigh, uint256 domainLow) = _split(settlementDomainHash);
        uint256[6] memory publicSignals = [
            batchRoot,
            uint256(PROTOCOL_VERSION),
            domainHigh,
            domainLow,
            uint256(epoch),
            uint256(realCount)
        ];
        require(
            verifier.verifyProof(pA, pB, pC, publicSignals),
            "RegistryV2: invalid proof"
        );

        batches[batchKey] = RegisteredBatch({
            epoch: epoch,
            realCount: realCount,
            batchRoot: batchRoot,
            sourceBlockNumber: uint64(block.number),
            exists: true
        });
        emit BatchProofRegistered(batchKey, epoch, batchRoot, realCount);
    }

    function getRegisteredBatch(
        bytes32 batchKey
    ) external view returns (RegisteredBatch memory) {
        return batches[batchKey];
    }

    function _split(
        bytes32 value
    ) private pure returns (uint256 high, uint256 low) {
        uint256 numeric = uint256(value);
        high = numeric >> 128;
        low = uint128(numeric);
    }
}

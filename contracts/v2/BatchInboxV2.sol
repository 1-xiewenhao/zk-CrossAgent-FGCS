// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

abstract contract BatchInboxV2 {
    uint16 internal constant INBOX_PROTOCOL_VERSION = 2;
    uint256 internal constant INBOX_SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint8 public constant BATCH_TREE_DEPTH = 4;
    uint16 public constant BATCH_CAPACITY = 16;

    address public immutable trustedEndpoint;
    uint64 public immutable sourceChainId;
    address public immutable sourceRegistry;

    struct AcceptedBatch {
        uint64 epoch;
        uint16 realCount;
        uint256 batchRoot;
        uint64 sourceBlockNumber;
        bytes32 sourceTransactionHash;
        bool exists;
    }

    mapping(bytes32 => AcceptedBatch) internal acceptedBatches;

    event BatchRootAccepted(
        bytes32 indexed batchKey,
        uint64 indexed epoch,
        uint256 indexed batchRoot,
        uint16 realCount,
        uint64 sourceBlockNumber,
        bytes32 sourceTransactionHash
    );

    constructor(
        address _trustedEndpoint,
        uint64 _sourceChainId,
        address _sourceRegistry
    ) {
        require(_trustedEndpoint != address(0), "InboxV2: zero endpoint");
        require(_sourceChainId > 0, "InboxV2: zero source chain");
        require(_sourceRegistry != address(0), "InboxV2: zero source registry");
        trustedEndpoint = _trustedEndpoint;
        sourceChainId = _sourceChainId;
        sourceRegistry = _sourceRegistry;
    }

    modifier onlyTrustedEndpoint() {
        require(msg.sender == trustedEndpoint, "InboxV2: untrusted endpoint");
        _;
    }

    function computeBatchKey(
        uint64 epoch,
        uint256 batchRoot
    ) public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    INBOX_PROTOCOL_VERSION,
                    sourceChainId,
                    sourceRegistry,
                    block.chainid,
                    address(this),
                    epoch,
                    batchRoot
                )
            );
    }

    function acceptBatchRoot(
        uint64 epoch,
        uint16 realCount,
        uint256 batchRoot,
        uint64 sourceBlockNumber,
        bytes32 sourceTransactionHash
    ) external onlyTrustedEndpoint returns (bytes32 batchKey) {
        require(realCount > 0, "InboxV2: empty batch");
        require(realCount <= BATCH_CAPACITY, "InboxV2: oversized batch");
        require(
            batchRoot > 0 && batchRoot < INBOX_SNARK_SCALAR_FIELD,
            "InboxV2: invalid root"
        );
        require(
            sourceTransactionHash != bytes32(0),
            "InboxV2: zero source tx"
        );

        batchKey = computeBatchKey(epoch, batchRoot);
        require(!acceptedBatches[batchKey].exists, "InboxV2: duplicate batch");

        acceptedBatches[batchKey] = AcceptedBatch({
            epoch: epoch,
            realCount: realCount,
            batchRoot: batchRoot,
            sourceBlockNumber: sourceBlockNumber,
            sourceTransactionHash: sourceTransactionHash,
            exists: true
        });

        emit BatchRootAccepted(
            batchKey,
            epoch,
            batchRoot,
            realCount,
            sourceBlockNumber,
            sourceTransactionHash
        );
    }

    function getAcceptedBatch(
        bytes32 batchKey
    ) external view returns (AcceptedBatch memory) {
        return acceptedBatches[batchKey];
    }
}

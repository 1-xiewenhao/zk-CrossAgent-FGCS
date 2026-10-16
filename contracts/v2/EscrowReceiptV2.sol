// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./BatchInboxV2.sol";
import "./RootCapabilityRegistryV2.sol";
import "./ZkCrossAgentTypes.sol";
import "./interfaces/IPoseidonT3.sol";
import "./interfaces/IPoseidonT7.sol";

contract EscrowReceiptV2 is
    RootCapabilityRegistryV2,
    BatchInboxV2,
    ReentrancyGuard
{
    using ECDSA for bytes32;

    uint256 private constant IDENTITY_TAG = 1001;
    uint256 private constant IDENTITY_CONT_TAG = 1002;
    uint256 private constant IDENTITY_FINAL_TAG = 1003;
    uint256 private constant DELIVERY_TAG = 1010;
    uint256 private constant DELIVERY_FINAL_TAG = 1011;
    uint256 private constant ECONOMICS_TAG = 1020;
    uint256 private constant RECEIPT_TAG = 1030;
    uint256 private constant REAL_LEAF_TAG = 1040;

    bytes32 private constant RECEIPT_IDENTITY_TYPEHASH =
        keccak256(
            "ReceiptIdentityV2(bytes32 callId,bytes32 taskId,uint256 rootCommitment,uint256 childCommitment,address payer,address buyer,address orchestrator,address provider)"
        );
    bytes32 private constant DELIVERY_TYPEHASH =
        keccak256(
            "DeliveryCommitmentV2(bytes32 requestHash,bytes32 responseHash,bytes32 ciphertextHash,bytes32 keyCommitment)"
        );
    bytes32 private constant ECONOMICS_TYPEHASH =
        keccak256(
            "ReceiptEconomicsV2(uint64 providerAmount,uint64 orchestratorFee,uint64 createdAt,bytes32 settlementDomainHash)"
        );
    bytes32 private constant RECEIPT_TYPEHASH =
        keccak256(
            "ReceiptCoreV2(uint16 protocolVersion,ReceiptIdentityV2 identity,DeliveryCommitmentV2 delivery,ReceiptEconomicsV2 economics,uint256 receiptCommitment)DeliveryCommitmentV2(bytes32 requestHash,bytes32 responseHash,bytes32 ciphertextHash,bytes32 keyCommitment)ReceiptEconomicsV2(uint64 providerAmount,uint64 orchestratorFee,uint64 createdAt,bytes32 settlementDomainHash)ReceiptIdentityV2(bytes32 callId,bytes32 taskId,uint256 rootCommitment,uint256 childCommitment,address payer,address buyer,address orchestrator,address provider)"
        );
    bytes32 private constant CALLER_CONFIRMATION_TYPEHASH =
        keccak256(
            "CallerConfirmationV2(uint16 protocolVersion,bytes32 callId,uint256 receiptCommitment,bytes32 providerSignatureHash,bytes32 settlementDomainHash)"
        );

    bytes32 private constant ROOT_BUDGET_RELEASE_TYPEHASH = keccak256(
        "RootBudgetReleaseV2(uint16 protocolVersion,uint256 rootCommitment,address payer,uint64 settledAmount,uint32 settledCalls,uint64 validUntil,bytes32 settlementDomainHash)"
    );
    address public immutable fundsReleaseAuthority;
    mapping(address => uint256) public protectedBudget;
    mapping(uint256 => bool) public rootFundsReleased;

    event Withdrawn(address indexed payer, address indexed recipient, uint256 amount);
    event RootBudgetReleased(uint256 indexed rootCommitment, address indexed payer, uint256 unusedAmount);

    IPoseidonT3 public immutable poseidon2;
    IPoseidonT7 public immutable poseidon6;

    mapping(address => uint256) public escrowBalance;
    mapping(bytes32 => bool) public isSettled;

    event Deposited(address indexed payer, uint256 amount);
    event ReceiptSettledV2(
        bytes32 indexed callId,
        bytes32 indexed batchKey,
        uint256 indexed rootCommitment,
        address payer,
        address provider,
        address orchestrator,
        uint64 providerAmount,
        uint64 orchestratorFee
    );

    constructor(
        bytes32 _settlementDomainHash,
        address _trustedEndpoint,
        uint64 _sourceChainId,
        address _sourceRegistry,
        address _poseidon2,
        address _poseidon6,
        address _fundsReleaseAuthority
    )
        RootCapabilityRegistryV2(_settlementDomainHash)
        BatchInboxV2(_trustedEndpoint, _sourceChainId, _sourceRegistry)
    {
        require(_poseidon2 != address(0), "EscrowV2: zero poseidon2");
        require(_poseidon6 != address(0), "EscrowV2: zero poseidon6");
        require(_fundsReleaseAuthority != address(0), "EscrowV2: zero release authority");
        fundsReleaseAuthority = _fundsReleaseAuthority;
        poseidon2 = IPoseidonT3(_poseidon2);
        poseidon6 = IPoseidonT7(_poseidon6);
    }

    function depositFor(address payer) external payable {
        require(payer != address(0), "EscrowV2: zero payer");
        require(msg.value > 0, "EscrowV2: zero deposit");
        escrowBalance[payer] += msg.value;
        emit Deposited(payer, msg.value);
    }

    /// @dev Protect the entire unspent root envelope, including off-chain claims.
    function _afterRootRegistered(uint256 commitment) internal override {
        RootRecord storage root = rootRecords[commitment];
        protectedBudget[root.payer] += root.budget;
    }

    function withdrawableBalance(address payer) public view returns (uint256) {
        uint256 balance = escrowBalance[payer];
        uint256 protected = protectedBudget[payer];
        return balance > protected ? balance - protected : 0;
    }

    function withdraw(uint256 amount, address payable recipient) external nonReentrant {
        require(amount > 0, "EscrowV2: zero withdrawal");
        require(recipient != address(0) && recipient != address(this), "EscrowV2: invalid recipient");
        require(amount <= withdrawableBalance(msg.sender), "EscrowV2: protected funds");
        escrowBalance[msg.sender] -= amount;
        (bool success, ) = recipient.call{value: amount}("");
        require(success, "EscrowV2: withdrawal failed");
        emit Withdrawn(msg.sender, recipient, amount);
    }

    /// @notice Release an expired root's unused envelope after gateway reconciliation.
    /// @dev Expiry alone is insufficient: timely receipts may settle after expiry.
    function releaseUnusedRootBudget(
        uint256 commitment,
        uint64 settledAmount,
        uint32 settledCalls,
        uint64 validUntil,
        bytes calldata authorization
    ) external nonReentrant {
        RootRecord storage root = rootRecords[commitment];
        require(root.exists, "EscrowV2: unknown root");
        require(!rootFundsReleased[commitment], "EscrowV2: root funds already released");
        require(block.timestamp >= root.expiry, "EscrowV2: root still active");
        require(block.timestamp <= validUntil, "EscrowV2: release authorization expired");
        require(root.settledAmount == settledAmount && root.settledCalls == settledCalls,
            "EscrowV2: settlement snapshot changed");
        bytes32 statement = keccak256(abi.encode(
            ROOT_BUDGET_RELEASE_TYPEHASH, PROTOCOL_VERSION, commitment, root.payer,
            settledAmount, settledCalls, validUntil, settlementDomainHash
        ));
        require(_hashTypedDataV4(statement).recover(authorization) == fundsReleaseAuthority,
            "EscrowV2: invalid release authority");
        uint256 unused = uint256(root.budget) - root.settledAmount;
        rootFundsReleased[commitment] = true;
        protectedBudget[root.payer] -= unused;
        emit RootBudgetReleased(commitment, root.payer, unused);
    }

    function computeReceiptCommitment(
        ZkCrossAgentTypes.ReceiptCore calldata receipt
    ) public view returns (uint256) {
        uint256 identityCommitment = _identityCommitment(receipt);
        uint256 deliveryCommitment = _deliveryCommitment(receipt);
        uint256 economicsCommitment = _economicsCommitment(receipt);

        return
            poseidon6.poseidon(
                [
                    RECEIPT_TAG,
                    identityCommitment,
                    deliveryCommitment,
                    economicsCommitment,
                    receipt.economics.createdAt,
                    0
                ]
            );
    }

    function _identityCommitment(
        ZkCrossAgentTypes.ReceiptCore calldata receipt
    ) internal view returns (uint256) {
        (uint256 callHi, uint256 callLo) = _split(receipt.identity.callId);
        (uint256 taskHi, uint256 taskLo) = _split(receipt.identity.taskId);
        uint256 first = poseidon6.poseidon(
            [
                IDENTITY_TAG,
                callHi,
                callLo,
                taskHi,
                taskLo,
                receipt.identity.rootCommitment
            ]
        );
        uint256 second = poseidon6.poseidon(
            [
                IDENTITY_CONT_TAG,
                first,
                receipt.identity.childCommitment,
                uint256(uint160(receipt.identity.payer)),
                uint256(uint160(receipt.identity.buyer)),
                uint256(uint160(receipt.identity.orchestrator))
            ]
        );
        return
            poseidon6.poseidon(
                [
                    IDENTITY_FINAL_TAG,
                    second,
                    uint256(uint160(receipt.identity.provider)),
                    0,
                    0,
                    0
                ]
            );
    }

    function _deliveryCommitment(
        ZkCrossAgentTypes.ReceiptCore calldata receipt
    ) internal view returns (uint256) {
        (uint256 requestHi, uint256 requestLo) = _split(
            receipt.delivery.requestHash
        );
        (uint256 responseHi, uint256 responseLo) = _split(
            receipt.delivery.responseHash
        );
        (uint256 ciphertextHi, uint256 ciphertextLo) = _split(
            receipt.delivery.ciphertextHash
        );
        (uint256 keyHi, uint256 keyLo) = _split(
            receipt.delivery.keyCommitment
        );
        uint256 first = poseidon6.poseidon(
            [
                DELIVERY_TAG,
                requestHi,
                requestLo,
                responseHi,
                responseLo,
                ciphertextHi
            ]
        );
        return
            poseidon6.poseidon(
                [
                    DELIVERY_FINAL_TAG,
                    first,
                    ciphertextLo,
                    keyHi,
                    keyLo,
                    0
                ]
            );
    }

    function _economicsCommitment(
        ZkCrossAgentTypes.ReceiptCore calldata receipt
    ) internal view returns (uint256) {
        (uint256 domainHi, uint256 domainLo) = _split(
            receipt.economics.settlementDomainHash
        );
        return
            poseidon6.poseidon(
                [
                    ECONOMICS_TAG,
                    receipt.protocolVersion,
                    domainHi,
                    domainLo,
                    receipt.economics.providerAmount,
                    receipt.economics.orchestratorFee
                ]
            );
    }

    function computeRealLeaf(
        uint256 receiptCommitment
    ) public view returns (uint256) {
        return poseidon2.poseidon([receiptCommitment, REAL_LEAF_TAG]);
    }

    function settleReceipt(
        ZkCrossAgentTypes.ReceiptCore calldata receipt,
        bytes calldata providerSignature,
        bytes calldata buyerSignature,
        bytes32 keyReveal,
        bytes32 batchKey,
        uint8 leafIndex,
        uint256[4] calldata merkleProof
    ) external nonReentrant {
        require(
            receipt.protocolVersion == PROTOCOL_VERSION,
            "EscrowV2: wrong version"
        );
        require(
            receipt.economics.settlementDomainHash == settlementDomainHash,
            "EscrowV2: wrong domain"
        );
        require(!isSettled[receipt.identity.callId], "EscrowV2: already settled");
        require(!rootFundsReleased[receipt.identity.rootCommitment], "EscrowV2: root funds released");
        require(
            receipt.receiptCommitment > 0 &&
                receipt.receiptCommitment < SNARK_SCALAR_FIELD,
            "EscrowV2: invalid receipt commitment"
        );
        require(
            computeReceiptCommitment(receipt) == receipt.receiptCommitment,
            "EscrowV2: receipt commitment mismatch"
        );
        require(
            keccak256(abi.encodePacked(keyReveal)) ==
                receipt.delivery.keyCommitment,
            "EscrowV2: invalid key reveal"
        );

        RootRecord storage root = rootRecords[
            receipt.identity.rootCommitment
        ];
        require(root.exists, "EscrowV2: unknown root");
        require(root.payer == receipt.identity.payer, "EscrowV2: payer mismatch");
        require(root.buyer == receipt.identity.buyer, "EscrowV2: buyer mismatch");
        require(root.taskId == receipt.identity.taskId, "EscrowV2: task mismatch");
        require(
            receipt.economics.createdAt <= root.expiry,
            "EscrowV2: receipt after expiry"
        );
        require(
            receipt.identity.provider != address(0),
            "EscrowV2: zero provider"
        );
        require(
            receipt.identity.orchestrator != address(0),
            "EscrowV2: zero orchestrator"
        );

        AcceptedBatch storage batch = acceptedBatches[batchKey];
        require(batch.exists, "EscrowV2: unknown batch");
        require(leafIndex < batch.realCount, "EscrowV2: non-real leaf");
        uint256 leaf = computeRealLeaf(receipt.receiptCommitment);
        require(
            _verifyMerkleProof(
                leaf,
                leafIndex,
                merkleProof,
                batch.batchRoot
            ),
            "EscrowV2: invalid inclusion proof"
        );

        _verifyReceiptSignatures(
            receipt,
            providerSignature,
            buyerSignature
        );

        uint64 totalAmount =
            receipt.economics.providerAmount +
            receipt.economics.orchestratorFee;
        require(totalAmount > 0, "EscrowV2: zero amount");
        require(
            escrowBalance[root.payer] >= totalAmount,
            "EscrowV2: insufficient escrow"
        );

        // Validate and consume root limits before subtracting the protected envelope.
        _consumeRootBudget(receipt.identity.rootCommitment, totalAmount);
        isSettled[receipt.identity.callId] = true;
        escrowBalance[root.payer] -= totalAmount;
        protectedBudget[root.payer] -= totalAmount;

        _pay(
            payable(receipt.identity.provider),
            receipt.economics.providerAmount
        );
        _pay(
            payable(receipt.identity.orchestrator),
            receipt.economics.orchestratorFee
        );

        _emitSettlement(receipt, batchKey, root.payer);
    }

    function _verifyReceiptSignatures(
        ZkCrossAgentTypes.ReceiptCore calldata receipt,
        bytes calldata providerSignature,
        bytes calldata buyerSignature
    ) internal view {
        bytes32 identityHash = keccak256(
            abi.encode(
                RECEIPT_IDENTITY_TYPEHASH,
                receipt.identity.callId,
                receipt.identity.taskId,
                receipt.identity.rootCommitment,
                receipt.identity.childCommitment,
                receipt.identity.payer,
                receipt.identity.buyer,
                receipt.identity.orchestrator,
                receipt.identity.provider
            )
        );
        bytes32 deliveryHash = keccak256(
            abi.encode(
                DELIVERY_TYPEHASH,
                receipt.delivery.requestHash,
                receipt.delivery.responseHash,
                receipt.delivery.ciphertextHash,
                receipt.delivery.keyCommitment
            )
        );
        bytes32 economicsHash = keccak256(
            abi.encode(
                ECONOMICS_TYPEHASH,
                receipt.economics.providerAmount,
                receipt.economics.orchestratorFee,
                receipt.economics.createdAt,
                receipt.economics.settlementDomainHash
            )
        );
        bytes32 receiptHash = keccak256(
            abi.encode(
                RECEIPT_TYPEHASH,
                receipt.protocolVersion,
                identityHash,
                deliveryHash,
                economicsHash,
                receipt.receiptCommitment
            )
        );
        address recoveredProvider = _hashTypedDataV4(receiptHash).recover(
            providerSignature
        );
        require(
            recoveredProvider == receipt.identity.provider,
            "EscrowV2: invalid provider signature"
        );

        bytes32 confirmationHash = keccak256(
            abi.encode(
                CALLER_CONFIRMATION_TYPEHASH,
                receipt.protocolVersion,
                receipt.identity.callId,
                receipt.receiptCommitment,
                keccak256(providerSignature),
                receipt.economics.settlementDomainHash
            )
        );
        address recoveredBuyer = _hashTypedDataV4(confirmationHash).recover(
            buyerSignature
        );
        require(
            recoveredBuyer == receipt.identity.buyer,
            "EscrowV2: invalid buyer signature"
        );
    }

    function _emitSettlement(
        ZkCrossAgentTypes.ReceiptCore calldata receipt,
        bytes32 batchKey,
        address payer
    ) internal {
        emit ReceiptSettledV2(
            receipt.identity.callId,
            batchKey,
            receipt.identity.rootCommitment,
            payer,
            receipt.identity.provider,
            receipt.identity.orchestrator,
            receipt.economics.providerAmount,
            receipt.economics.orchestratorFee
        );
    }

    function _verifyMerkleProof(
        uint256 leaf,
        uint8 leafIndex,
        uint256[4] calldata proof,
        uint256 expectedRoot
    ) internal view returns (bool) {
        uint256 computed = leaf;
        uint8 index = leafIndex;
        for (uint256 i = 0; i < BATCH_TREE_DEPTH; i++) {
            require(
                proof[i] < SNARK_SCALAR_FIELD,
                "EscrowV2: invalid proof field"
            );
            if ((index & 1) == 0) {
                computed = poseidon2.poseidon([computed, proof[i]]);
            } else {
                computed = poseidon2.poseidon([proof[i], computed]);
            }
            index >>= 1;
        }
        return computed == expectedRoot;
    }

    function _split(
        bytes32 value
    ) internal pure returns (uint256 high, uint256 low) {
        uint256 numeric = uint256(value);
        high = numeric >> 128;
        low = uint128(numeric);
    }

    function _pay(address payable recipient, uint64 amount) internal {
        if (amount == 0) return;
        (bool success, ) = recipient.call{value: amount}("");
        require(success, "EscrowV2: payment failed");
    }
}

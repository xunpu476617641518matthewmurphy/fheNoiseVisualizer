pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";


contract FheNoiseVisualizerFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error BatchNotClosed();
    error InvalidCooldown();
    error ReplayDetected();
    error StateMismatch();
    error NotInitialized();
    error InvalidBatchId();

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        uint256 batchId;
        bool closed;
    }
    Batch public currentBatch;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    euint32 private encryptedNoiseAccumulator;
    euint32 private encryptedNoiseIncrement;
    euint32 private encryptedNoiseThreshold;
    euint32 private encryptedNoiseSnapshot;
    euint32 private encryptedNoiseSnapshotBatchId;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ContractPaused(address indexed account);
    event ContractUnpaused(address indexed account);
    event CooldownSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 batchId);
    event BatchClosed(uint256 batchId);
    event NoiseSubmitted(address indexed provider, uint256 batchId, bytes32 encryptedNoiseIncrement);
    event NoiseSnapshotTaken(uint256 batchId, bytes32 encryptedNoiseSnapshot);
    event ThresholdSet(uint256 batchId, bytes32 encryptedNoiseThreshold);
    event DecryptionRequested(uint256 indexed requestId, uint256 batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 batchId, uint256 noiseSnapshot, uint256 noiseThreshold);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 10; 
        _initIfNeeded();
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit ContractPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) revert Paused(); 
        paused = false;
        emit ContractUnpaused(msg.sender);
    }

    function setCooldown(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds == 0) revert InvalidCooldown();
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSet(oldCooldownSeconds, newCooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (!currentBatch.closed) revert BatchNotClosed();
        currentBatch.batchId++;
        currentBatch.closed = false;
        encryptedNoiseAccumulator = FHE.asEuint32(0);
        emit BatchOpened(currentBatch.batchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (currentBatch.closed) revert BatchClosed();
        currentBatch.closed = true;
        _takeNoiseSnapshot();
        emit BatchClosed(currentBatch.batchId);
    }

    function submitNoiseIncrement(euint32 _encryptedNoiseIncrement) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (currentBatch.closed) revert BatchClosed();
        lastSubmissionTime[msg.sender] = block.timestamp;

        _initIfNeeded();
        encryptedNoiseAccumulator = encryptedNoiseAccumulator.add(_encryptedNoiseIncrement);
        emit NoiseSubmitted(msg.sender, currentBatch.batchId, _encryptedNoiseIncrement.toBytes32());
    }

    function setNoiseThreshold(euint32 _encryptedNoiseThreshold) external onlyOwner whenNotPaused {
        if (currentBatch.closed) revert BatchClosed();
        encryptedNoiseThreshold = _encryptedNoiseThreshold;
        emit ThresholdSet(currentBatch.batchId, _encryptedNoiseThreshold.toBytes32());
    }

    function takeNoiseSnapshot() external onlyOwner whenNotPaused {
        if (currentBatch.closed) revert BatchClosed();
        _takeNoiseSnapshot();
    }

    function requestNoiseVisualization() external onlyProvider whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!currentBatch.closed) revert BatchNotClosed(); 
        if (!FHE.isInitialized(encryptedNoiseSnapshot)) revert NotInitialized();
        if (!FHE.isInitialized(encryptedNoiseThreshold)) revert NotInitialized();

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        euint32[] memory cts = new euint32[](2);
        cts[0] = encryptedNoiseSnapshot;
        cts[1] = encryptedNoiseThreshold;

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: currentBatch.batchId,
            stateHash: stateHash,
            processed: false
        });

        emit DecryptionRequested(requestId, currentBatch.batchId, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();
        if (decryptionContexts[requestId].batchId != currentBatch.batchId) revert InvalidBatchId();

        euint32[] memory cts = new euint32[](2);
        cts[0] = encryptedNoiseSnapshot;
        cts[1] = encryptedNoiseThreshold;

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint256 noiseSnapshot = abi.decode(cleartexts[0:32], (uint256));
        uint256 noiseThreshold = abi.decode(cleartexts[32:64], (uint256));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, noiseSnapshot, noiseThreshold);
    }

    function _initIfNeeded() private {
        if (!FHE.isInitialized(encryptedNoiseAccumulator)) {
            encryptedNoiseAccumulator = FHE.asEuint32(0);
        }
        if (!FHE.isInitialized(encryptedNoiseIncrement)) {
            encryptedNoiseIncrement = FHE.asEuint32(0);
        }
        if (!FHE.isInitialized(encryptedNoiseThreshold)) {
            encryptedNoiseThreshold = FHE.asEuint32(0);
        }
        if (!FHE.isInitialized(encryptedNoiseSnapshot)) {
            encryptedNoiseSnapshot = FHE.asEuint32(0);
        }
        if (!FHE.isInitialized(encryptedNoiseSnapshotBatchId)) {
            encryptedNoiseSnapshotBatchId = FHE.asEuint32(0);
        }
    }

    function _requireInitialized(euint32 val) private view {
        if (!FHE.isInitialized(val)) revert NotInitialized();
    }

    function _hashCiphertexts(euint32[] memory cts) private view returns (bytes32) {
        bytes32[] memory ctsAsBytes = new bytes32[](cts.length);
        for (uint i = 0; i < cts.length; i++) {
            ctsAsBytes[i] = cts[i].toBytes32();
        }
        return keccak256(abi.encode(ctsAsBytes, address(this)));
    }

    function _takeNoiseSnapshot() private {
        _requireInitialized(encryptedNoiseAccumulator);
        encryptedNoiseSnapshot = encryptedNoiseAccumulator;
        encryptedNoiseSnapshotBatchId = FHE.asEuint32(currentBatch.batchId);
        emit NoiseSnapshotTaken(currentBatch.batchId, encryptedNoiseSnapshot.toBytes32());
    }
}
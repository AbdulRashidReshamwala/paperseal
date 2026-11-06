// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title ExamRegistry
/// @notice Write-once public record of each exam. Only the board address can write.
/// @dev The approved list and selection criteria are stored as hashes and emitted in full. Neither is decoded
///      here; each is only length-capped, since ABI offsets let a small input decode to a huge one. TEE
///      signatures are stored, not verified, because the attested key exists only off-chain. The length and
///      format checks only stop a mistyped value from filling a write-once slot. Rounds are checked against
///      quicknet timing, never against block time or drand output.
contract ExamRegistry {
    struct ExamSettings {
        bytes32 examId;
        uint64 examStart;
        uint64 delta;
        uint64 lockRound;
        uint64 unlockRound;
        uint64 endRound;
        bytes32 criteriaHash;
        string rpcHost;
    }

    /// @dev `createdAt` and each record's `postedAt` are block timestamps; zero means not written. Neither is a
    ///      clock for the exam. `createdBlock` and `postedBlock` locate the event, since public RPCs reject
    ///      wide log ranges.
    struct Exam {
        bytes20 commitHash;
        bytes32 imageDigest;
        uint64 createdAt;
        uint64 createdBlock;
        ExamSettings settings;
    }

    struct ApprovedList {
        bytes32 listHash;
        uint64 postedAt;
        uint64 postedBlock;
    }

    struct Build {
        bytes32 approvedListHash;
        bytes32 paperHash;
        bytes32 storageManifestHash;
        bytes32 saltedPaperHash;
        uint32 selected;
        uint32 bankSize;
        uint64 builtRound;
        uint64 postedAt;
        bytes32 criteriaHash;
        bytes teeSignature;
        bytes instancePublicKey;
    }

    /// @notice The TEE's `build` message fields after `examId`, in the order it hashes them. `builtRound` is the
    ///         newest verified drand round when the TEE sealed the paper.
    struct BuildFields {
        bytes32 approvedListHash;
        bytes32 paperHash;
        bytes32 storageManifestHash;
        bytes32 saltedPaperHash;
        uint32 selected;
        uint32 bankSize;
        bytes32 criteriaHash;
        uint64 builtRound;
    }

    event ExamCreated(
        bytes32 indexed examId,
        bytes20 commitHash,
        bytes32 imageDigest,
        uint64 examStart,
        uint64 delta,
        uint64 lockRound,
        uint64 unlockRound,
        uint64 endRound,
        bytes32 criteriaHash,
        string rpcHost,
        bytes criteria
    );
    event ApprovedListPosted(bytes32 indexed examId, bytes32 listHash, bytes entries);
    event BuildPosted(
        bytes32 indexed examId,
        bytes32 approvedListHash,
        bytes32 paperHash,
        bytes32 storageManifestHash,
        bytes32 saltedPaperHash,
        uint32 selected,
        uint32 bankSize,
        bytes32 criteriaHash,
        uint64 builtRound,
        bytes teeSignature,
        bytes instancePublicKey
    );

    error NotBoard(address caller);
    error ZeroBoardAddress();
    error ZeroValue();
    error InvalidRounds();
    error InvalidExamStart();
    error InvalidEndRound();
    error InvalidPublicKey();
    error InvalidSignatureLength();
    error InvalidSelection();
    error ExamNotFound(bytes32 examId);
    error ExamAlreadyExists(bytes32 examId);
    error ApprovedListNotPosted(bytes32 examId);
    error ApprovedListAlreadyPosted(bytes32 examId);
    error BuildAlreadyPosted(bytes32 examId);
    error UnlockRoundMismatch(uint256 expected, uint256 actual);
    error ApprovedListHashMismatch(bytes32 expected, bytes32 actual);
    error CriteriaHashMismatch(bytes32 expected, bytes32 actual);
    error EntriesTooLarge();
    error CriteriaTooLarge();

    /// @notice Unix time of quicknet round 1.
    uint64 public constant QUICKNET_GENESIS_TIME = 1692803367;
    /// @notice Seconds between quicknet rounds.
    uint64 public constant QUICKNET_PERIOD_SECONDS = 3;

    string private constant CRITERIA_TAG = "paperseal/v1/criteria";
    string private constant APPROVED_LIST_TAG = "paperseal/v1/approved-list";
    /// @dev Matches `limits.entriesBytes` in spec/constants.json.
    uint256 private constant ENTRIES_BYTES = 130000;
    /// @dev Matches `limits.criteriaBytes` in spec/constants.json.
    uint256 private constant CRITERIA_BYTES = 16384;
    /// @dev Uncompressed P-256 key: 0x04, x, y.
    uint256 private constant PUBLIC_KEY_LENGTH = 65;
    /// @dev r || s.
    uint256 private constant SIGNATURE_LENGTH = 64;

    /// @notice The only address that can write.
    address public immutable board;

    mapping(bytes32 examId => Exam) private _exams;
    mapping(bytes32 examId => ApprovedList) private _approvedLists;
    mapping(bytes32 examId => Build) private _builds;

    modifier onlyBoard() {
        if (msg.sender != board) revert NotBoard(msg.sender);
        _;
    }

    constructor(address board_) {
        if (board_ == address(0)) revert ZeroBoardAddress();
        board = board_;
    }

    /// @notice Publishes the commit, image digest and exam settings.
    /// @param commitHash The git commit the image is built from.
    /// @param imageDigest The SHA-256 digest of the container image.
    /// @param settings The attested exam settings.
    /// @param criteria `abi.encode(Criteria)`. Emitted, not stored; must hash to `settings.criteriaHash`.
    function createExam(
        bytes20 commitHash,
        bytes32 imageDigest,
        ExamSettings calldata settings,
        bytes calldata criteria
    ) external onlyBoard {
        bytes32 examId = settings.examId;
        if (_exams[examId].createdAt != 0) revert ExamAlreadyExists(examId);
        if (
            examId == bytes32(0) || commitHash == bytes20(0) || imageDigest == bytes32(0)
                || settings.criteriaHash == bytes32(0) || settings.delta == 0 || bytes(settings.rpcHost).length == 0
                || criteria.length == 0
        ) revert ZeroValue();
        if (criteria.length > CRITERIA_BYTES) revert CriteriaTooLarge();
        _checkSchedule(settings);
        _checkCriteria(settings.criteriaHash, criteria);

        _exams[examId] = Exam({
            commitHash: commitHash,
            imageDigest: imageDigest,
            createdAt: _now(),
            createdBlock: _blockNumber(),
            settings: settings
        });

        emit ExamCreated(
            examId,
            commitHash,
            imageDigest,
            settings.examStart,
            settings.delta,
            settings.lockRound,
            settings.unlockRound,
            settings.endRound,
            settings.criteriaHash,
            settings.rpcHost,
            criteria
        );
    }

    /// @notice Stores the hash of the approved list and emits the full bytes.
    /// @param entries `abi.encode(Entry[])`, hashed as posted.
    function postApprovedList(bytes32 examId, bytes calldata entries) external onlyBoard {
        if (_exams[examId].createdAt == 0) revert ExamNotFound(examId);
        if (_approvedLists[examId].postedAt != 0) revert ApprovedListAlreadyPosted(examId);
        if (entries.length == 0) revert ZeroValue();
        if (entries.length > ENTRIES_BYTES) revert EntriesTooLarge();

        bytes32 listHash = sha256(abi.encode(APPROVED_LIST_TAG, examId, entries));
        _approvedLists[examId] = ApprovedList({listHash: listHash, postedAt: _now(), postedBlock: _blockNumber()});

        emit ApprovedListPosted(examId, listHash, entries);
    }

    /// @notice Posts the exam's one Build. Requires the approved list.
    /// @dev `approvedListHash` and `criteriaHash` must match the on-chain values, so a mistyped Build can't
    ///      fill the write-once slot.
    function postBuild(
        bytes32 examId,
        BuildFields calldata fields,
        bytes calldata teeSignature,
        bytes calldata instancePublicKey
    ) external onlyBoard {
        _checkBuild(examId, fields.approvedListHash, fields.criteriaHash);
        if (
            fields.paperHash == bytes32(0) || fields.storageManifestHash == bytes32(0)
                || fields.saltedPaperHash == bytes32(0)
        ) {
            revert ZeroValue();
        }
        if (fields.selected == 0 || fields.selected > fields.bankSize) revert InvalidSelection();
        // Format only. Readers compare the round with the exam's rounds.
        if (fields.builtRound == 0) revert ZeroValue();
        _checkTeeOutput(teeSignature, instancePublicKey);

        // Field by field: a struct literal this size is too deep for the legacy code generator.
        Build storage build = _builds[examId];
        build.approvedListHash = fields.approvedListHash;
        build.paperHash = fields.paperHash;
        build.storageManifestHash = fields.storageManifestHash;
        build.saltedPaperHash = fields.saltedPaperHash;
        build.selected = fields.selected;
        build.bankSize = fields.bankSize;
        build.builtRound = fields.builtRound;
        build.postedAt = _now();
        build.criteriaHash = fields.criteriaHash;
        build.teeSignature = teeSignature;
        build.instancePublicKey = instancePublicKey;

        emit BuildPosted(
            examId,
            fields.approvedListHash,
            fields.paperHash,
            fields.storageManifestHash,
            fields.saltedPaperHash,
            fields.selected,
            fields.bankSize,
            fields.criteriaHash,
            fields.builtRound,
            teeSignature,
            instancePublicKey
        );
    }

    /// @notice Returns the exam; `createdAt` is zero if it doesn't exist.
    function getExam(bytes32 examId) external view returns (Exam memory) {
        return _exams[examId];
    }

    /// @notice Returns the approved list record; `postedAt` is zero if not posted.
    function getApprovedList(bytes32 examId) external view returns (ApprovedList memory) {
        return _approvedLists[examId];
    }

    /// @notice Returns the Build record; `postedAt` is zero if not posted.
    function getBuild(bytes32 examId) external view returns (Build memory) {
        return _builds[examId];
    }

    function _now() private view returns (uint64) {
        // casting to 'uint64' is safe because block timestamps won't reach 2^64 seconds
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(block.timestamp);
    }

    function _blockNumber() private view returns (uint64) {
        // casting to 'uint64' is safe because block numbers won't reach 2^64
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(block.number);
    }

    /// @dev Round r is produced at genesis + (r - 1) * period. Math is in uint256 so extreme settings revert
    ///      with these errors, not a panic. Round order is checked first, so `endRound` is at least 3.
    function _checkSchedule(ExamSettings calldata settings) private pure {
        if (
            settings.lockRound == 0 || settings.unlockRound <= settings.lockRound
                || settings.endRound <= settings.unlockRound
        ) revert InvalidRounds();
        if (settings.examStart <= uint256(settings.delta) + QUICKNET_GENESIS_TIME) revert InvalidExamStart();

        uint256 unlockOffset = uint256(settings.examStart) - settings.delta - QUICKNET_GENESIS_TIME;
        uint256 expectedUnlock = (unlockOffset + QUICKNET_PERIOD_SECONDS - 1) / QUICKNET_PERIOD_SECONDS + 1;
        if (settings.unlockRound != expectedUnlock) revert UnlockRoundMismatch(expectedUnlock, settings.unlockRound);

        uint256 endTime = QUICKNET_GENESIS_TIME + (uint256(settings.endRound) - 1) * QUICKNET_PERIOD_SECONDS;
        if (endTime <= settings.examStart) revert InvalidEndRound();
    }

    function _checkCriteria(bytes32 criteriaHash, bytes calldata criteria) private pure {
        bytes32 actual = sha256(abi.encode(CRITERIA_TAG, criteria));
        if (actual != criteriaHash) revert CriteriaHashMismatch(criteriaHash, actual);
    }

    function _checkBuild(bytes32 examId, bytes32 approvedListHash, bytes32 criteriaHash) private view {
        ApprovedList storage list = _approvedLists[examId];
        if (list.postedAt == 0) revert ApprovedListNotPosted(examId);
        if (_builds[examId].postedAt != 0) revert BuildAlreadyPosted(examId);
        if (approvedListHash != list.listHash) revert ApprovedListHashMismatch(list.listHash, approvedListHash);
        bytes32 expectedCriteria = _exams[examId].settings.criteriaHash;
        if (criteriaHash != expectedCriteria) revert CriteriaHashMismatch(expectedCriteria, criteriaHash);
    }

    function _checkTeeOutput(bytes calldata teeSignature, bytes calldata instancePublicKey) private pure {
        if (teeSignature.length != SIGNATURE_LENGTH) revert InvalidSignatureLength();
        _checkPublicKey(instancePublicKey);
    }

    function _checkPublicKey(bytes calldata publicKey) private pure {
        if (publicKey.length != PUBLIC_KEY_LENGTH || publicKey[0] != 0x04) revert InvalidPublicKey();
    }
}

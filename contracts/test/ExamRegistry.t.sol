// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {ExamRegistry} from "../src/ExamRegistry.sol";
import {Deploy} from "../script/Deploy.s.sol";

contract ExamRegistryTest is Test {
    /// @dev The list entry from spec/api.md. Only tests use it, because the contract never decodes entries.
    struct Entry {
        uint8 role;
        bytes passkeyPublicKey;
        bytes derivedPublicKey;
        string owner;
    }

    /// @dev The selection criteria from spec/api.md. Only tests use these, because the contract never decodes them.
    struct Topic {
        string name;
        uint32 questions;
    }

    struct Criteria {
        uint32 maxSetterPercent;
        uint32 minBankMultiple;
        Topic[] topics;
    }

    address internal constant BOARD = address(0xB0A2D);
    address internal constant STRANGER = address(0xBAD);

    bytes32 internal constant EXAM_ID = keccak256("Physics Paper 1, June 2027");
    bytes32 internal constant OTHER_EXAM_ID = keccak256("Physics Paper 2, June 2027");
    bytes20 internal constant COMMIT = bytes20(keccak256("commit"));
    bytes32 internal constant DIGEST = keccak256("digest");
    bytes32 internal constant PAPER_HASH = keccak256("paper");
    bytes32 internal constant MANIFEST_HASH = keccak256("manifest");
    bytes32 internal constant SALTED_HASH = keccak256("salted");
    bytes32 internal constant OTHER = keccak256("other");
    uint32 internal constant QUESTIONS = 200;
    uint32 internal constant SELECTED = 20;
    string internal constant RPC_HOST = "rpc.example.org";

    // Literal quicknet timing, separate from the contract's constants. Round r is produced at
    // GENESIS + (r - 1) * 3, so T - delta below lands exactly on round 40_000_001.
    uint64 internal constant GENESIS = 1692803367;
    uint64 internal constant DELTA = 3_600;
    uint64 internal constant EXAM_START = GENESIS + 120_000_000 + DELTA;
    uint64 internal constant LOCK_ROUND = 39_000_000;
    uint64 internal constant UNLOCK_ROUND = 40_000_001;
    uint64 internal constant END_ROUND = 40_002_401;
    // The first round produced after EXAM_START. The round before lands exactly on EXAM_START.
    uint64 internal constant FIRST_END_ROUND = 40_001_202;

    ExamRegistry internal registry;
    bytes internal criteria;
    bytes32 internal criteriaHash;
    bytes internal entries;
    bytes32 internal listHash;
    bytes internal sig;
    bytes internal key;
    bytes internal otherSig;
    bytes internal otherKey;

    function setUp() public {
        registry = new ExamRegistry(BOARD);
        sig = _filled(0x11, 64);
        key = _publicKey(0x22);
        otherSig = _filled(0x33, 64);
        otherKey = _publicKey(0x44);
        criteria = abi.encode(_sampleCriteria());
        criteriaHash = _expectedCriteriaHash(criteria);
        entries = abi.encode(_sampleEntries());
        listHash = _expectedListHash(EXAM_ID, entries);
        vm.warp(1_800_000_000);
    }

    function _filled(uint8 value, uint256 length) internal pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i; i < length; ++i) {
            out[i] = bytes1(value);
        }
    }

    function _publicKey(uint8 value) internal pure returns (bytes memory out) {
        out = _filled(value, 65);
        out[0] = 0x04;
    }

    function _sampleCriteria() internal pure returns (Criteria memory sample) {
        sample.maxSetterPercent = 10;
        sample.minBankMultiple = 5;
        sample.topics = new Topic[](2);
        sample.topics[0] = Topic({name: "Mechanics", questions: 12});
        sample.topics[1] = Topic({name: "Optics", questions: 8});
    }

    function _expectedCriteriaHash(bytes memory encoded) internal pure returns (bytes32) {
        string memory tag = "paperseal/v1/criteria";
        return sha256(abi.encode(tag, encoded));
    }

    function _sampleEntries() internal pure returns (Entry[] memory list) {
        list = new Entry[](2);
        list[0] = Entry({role: 1, passkeyPublicKey: _publicKey(0x55), derivedPublicKey: "", owner: "Setter"});
        list[1] = Entry({
            role: 4, passkeyPublicKey: _publicKey(0x66), derivedPublicKey: _publicKey(0x77), owner: "Centre 12"
        });
    }

    function _expectedListHash(bytes32 examId, bytes memory list) internal pure returns (bytes32) {
        string memory tag = "paperseal/v1/approved-list";
        return sha256(abi.encode(tag, examId, list));
    }

    function _constants() internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/../spec/constants.json"));
    }

    function _settings(bytes32 examId) internal view returns (ExamRegistry.ExamSettings memory) {
        return ExamRegistry.ExamSettings({
            examId: examId,
            examStart: EXAM_START,
            delta: DELTA,
            lockRound: LOCK_ROUND,
            unlockRound: UNLOCK_ROUND,
            endRound: END_ROUND,
            criteriaHash: criteriaHash,
            rpcHost: RPC_HOST
        });
    }

    function _create() internal {
        vm.prank(BOARD);
        registry.createExam(COMMIT, DIGEST, _settings(EXAM_ID), criteria);
    }

    function _postList() internal {
        _create();
        vm.prank(BOARD);
        registry.postApprovedList(EXAM_ID, entries);
    }

    function _build() internal {
        registry.postBuild(
            EXAM_ID, listHash, PAPER_HASH, MANIFEST_HASH, SALTED_HASH, SELECTED, QUESTIONS, criteriaHash, sig, key
        );
    }

    function _postBuild() internal {
        _postList();
        vm.prank(BOARD);
        _build();
    }

    function _expectCreateReverts(ExamRegistry.ExamSettings memory settings, bytes memory reason) internal {
        vm.expectRevert(reason);
        vm.prank(BOARD);
        registry.createExam(COMMIT, DIGEST, settings, criteria);
    }

    function _expectCreateReverts(ExamRegistry.ExamSettings memory settings, bytes4 reason) internal {
        _expectCreateReverts(settings, abi.encodeWithSelector(reason));
    }

    function _createAccepted(ExamRegistry.ExamSettings memory settings) internal {
        vm.prank(BOARD);
        registry.createExam(COMMIT, DIGEST, settings, criteria);
        assertEq(registry.getExam(settings.examId).settings.unlockRound, settings.unlockRound);
    }

    // Construction

    function test_Constructor_SetsBoard() public view {
        assertEq(registry.board(), BOARD);
    }

    function test_Constructor_RejectsZeroBoard() public {
        vm.expectRevert(ExamRegistry.ZeroBoardAddress.selector);
        new ExamRegistry(address(0));
    }

    // Shared constants

    function test_Constants_MatchSpec() public view {
        string memory json = _constants();
        assertEq(vm.parseJsonString(json, ".drand.network"), "quicknet");
        assertEq(vm.parseJsonUint(json, ".drand.genesisTime"), registry.QUICKNET_GENESIS_TIME());
        assertEq(vm.parseJsonUint(json, ".drand.periodSeconds"), registry.QUICKNET_PERIOD_SECONDS());
        assertEq(vm.parseJsonUint(json, ".drand.genesisTime"), GENESIS);
    }

    function test_Limits_MatchSpec() public {
        string memory json = _constants();
        uint256 entriesBytes = vm.parseJsonUint(json, ".limits.entriesBytes");
        uint256 criteriaBytes = vm.parseJsonUint(json, ".limits.criteriaBytes");
        assertEq(entriesBytes, 327680);
        assertEq(criteriaBytes, 16384);

        // The contract's constants are private, so check them through behaviour at the spec values.
        _create();
        vm.prank(BOARD);
        vm.expectRevert(ExamRegistry.EntriesTooLarge.selector);
        registry.postApprovedList(EXAM_ID, _filled(0x01, entriesBytes + 1));
        vm.prank(BOARD);
        registry.postApprovedList(EXAM_ID, _filled(0x01, entriesBytes));

        _expectCriteriaLength(criteriaBytes, bytes4(0));
        _expectCriteriaLength(criteriaBytes + 1, ExamRegistry.CriteriaTooLarge.selector);
    }

    function _expectCriteriaLength(uint256 length, bytes4 reason) internal {
        bytes memory big = _filled(0x02, length);
        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        settings.examId = keccak256(abi.encode("criteria-limit", length));
        settings.criteriaHash = _expectedCriteriaHash(big);
        vm.prank(BOARD);
        if (reason != bytes4(0)) vm.expectRevert(reason);
        registry.createExam(COMMIT, DIGEST, settings, big);
        if (reason == bytes4(0)) assertEq(registry.getExam(settings.examId).createdAt, block.timestamp);
    }

    function test_PostApprovedList_AcceptsExactlyMaxEntries() public {
        _create();
        bytes memory list = _filled(0x01, 327680);
        vm.prank(BOARD);
        registry.postApprovedList(EXAM_ID, list);
        assertEq(registry.getApprovedList(EXAM_ID).listHash, _expectedListHash(EXAM_ID, list));
    }

    function test_PostApprovedList_RejectsOneByteOverMaxEntries() public {
        _create();
        vm.expectRevert(ExamRegistry.EntriesTooLarge.selector);
        vm.prank(BOARD);
        registry.postApprovedList(EXAM_ID, _filled(0x01, 327681));
        assertEq(registry.getApprovedList(EXAM_ID).postedAt, 0);
    }

    function test_CreateExam_AcceptsExactlyMaxCriteria() public {
        bytes memory big = _filled(0x02, 16384);
        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        settings.criteriaHash = _expectedCriteriaHash(big);
        vm.prank(BOARD);
        registry.createExam(COMMIT, DIGEST, settings, big);
        assertEq(registry.getExam(EXAM_ID).settings.criteriaHash, settings.criteriaHash);
    }

    function test_CreateExam_RejectsOneByteOverMaxCriteria() public {
        // The hash is correct for the oversized bytes, so only the length check can reject them.
        bytes memory big = _filled(0x02, 16385);
        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        settings.criteriaHash = _expectedCriteriaHash(big);
        vm.expectRevert(ExamRegistry.CriteriaTooLarge.selector);
        vm.prank(BOARD);
        registry.createExam(COMMIT, DIGEST, settings, big);
        assertEq(registry.getExam(EXAM_ID).createdAt, 0);
    }

    // Access control

    function testFuzz_CreateExam_OnlyBoard(address caller) public {
        vm.assume(caller != BOARD);
        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        vm.expectRevert(abi.encodeWithSelector(ExamRegistry.NotBoard.selector, caller));
        vm.prank(caller);
        registry.createExam(COMMIT, DIGEST, settings, criteria);
    }

    function testFuzz_PostApprovedList_OnlyBoard(address caller) public {
        vm.assume(caller != BOARD);
        _create();
        vm.expectRevert(abi.encodeWithSelector(ExamRegistry.NotBoard.selector, caller));
        vm.prank(caller);
        registry.postApprovedList(EXAM_ID, entries);
    }

    function testFuzz_PostBuild_OnlyBoard(address caller) public {
        vm.assume(caller != BOARD);
        _postList();
        vm.expectRevert(abi.encodeWithSelector(ExamRegistry.NotBoard.selector, caller));
        vm.prank(caller);
        _build();
    }

    function test_AccessControl_CheckedBeforeEverythingElse() public {
        _postBuild();
        vm.expectRevert(abi.encodeWithSelector(ExamRegistry.NotBoard.selector, STRANGER));
        vm.prank(STRANGER);
        registry.postBuild(EXAM_ID, OTHER, OTHER, OTHER, OTHER, 1, 1, OTHER, sig, key);
    }

    // Write-once

    function test_CreateExam_WriteOnce() public {
        _create();
        ExamRegistry.ExamSettings memory moved = _settings(EXAM_ID);
        moved.examStart = EXAM_START + 3;
        moved.unlockRound = UNLOCK_ROUND + 1;
        moved.endRound = END_ROUND + 1;

        vm.expectRevert(abi.encodeWithSelector(ExamRegistry.ExamAlreadyExists.selector, EXAM_ID));
        vm.prank(BOARD);
        registry.createExam(bytes20(OTHER), OTHER, moved, criteria);

        ExamRegistry.Exam memory exam = registry.getExam(EXAM_ID);
        assertEq(exam.commitHash, COMMIT);
        assertEq(exam.imageDigest, DIGEST);
        assertEq(exam.settings.examStart, EXAM_START);
        assertEq(exam.settings.unlockRound, UNLOCK_ROUND);
        assertEq(exam.settings.endRound, END_ROUND);
    }

    function test_ExamDate_UnchangedByLaterWrites() public {
        _postBuild();
        ExamRegistry.ExamSettings memory moved = _settings(EXAM_ID);
        moved.examStart = EXAM_START + 3;
        moved.unlockRound = UNLOCK_ROUND + 1;
        vm.expectRevert(abi.encodeWithSelector(ExamRegistry.ExamAlreadyExists.selector, EXAM_ID));
        vm.prank(BOARD);
        registry.createExam(COMMIT, DIGEST, moved, criteria);

        ExamRegistry.ExamSettings memory expected = _settings(EXAM_ID);
        ExamRegistry.ExamSettings memory stored = registry.getExam(EXAM_ID).settings;
        assertEq(abi.encode(stored), abi.encode(expected));
    }

    function test_PostApprovedList_WriteOnce() public {
        _postList();
        bytes memory otherEntries = hex"0000000201";
        vm.expectRevert(abi.encodeWithSelector(ExamRegistry.ApprovedListAlreadyPosted.selector, EXAM_ID));
        vm.prank(BOARD);
        registry.postApprovedList(EXAM_ID, otherEntries);

        assertEq(registry.getApprovedList(EXAM_ID).listHash, listHash);
    }

    function test_PostBuild_OnePerExam() public {
        _postBuild();
        vm.expectRevert(abi.encodeWithSelector(ExamRegistry.BuildAlreadyPosted.selector, EXAM_ID));
        vm.prank(BOARD);
        registry.postBuild(EXAM_ID, listHash, OTHER, OTHER, OTHER, 1, 1, criteriaHash, otherSig, otherKey);

        ExamRegistry.Build memory build = registry.getBuild(EXAM_ID);
        assertEq(build.paperHash, PAPER_HASH);
        assertEq(build.storageManifestHash, MANIFEST_HASH);
        assertEq(build.saltedPaperHash, SALTED_HASH);
        assertEq(build.teeSignature, sig);
    }

    // Ordering

    function test_PostApprovedList_NeedsExam() public {
        vm.expectRevert(abi.encodeWithSelector(ExamRegistry.ExamNotFound.selector, EXAM_ID));
        vm.prank(BOARD);
        registry.postApprovedList(EXAM_ID, entries);
    }

    function test_PostBuild_NeedsApprovedList() public {
        _create();
        vm.expectRevert(abi.encodeWithSelector(ExamRegistry.ApprovedListNotPosted.selector, EXAM_ID));
        vm.prank(BOARD);
        _build();
    }

    function test_Ordering_IsPerExam() public {
        _postBuild();
        ExamRegistry.ExamSettings memory settings = _settings(OTHER_EXAM_ID);
        vm.prank(BOARD);
        registry.createExam(COMMIT, DIGEST, settings, criteria);

        vm.expectRevert(abi.encodeWithSelector(ExamRegistry.ApprovedListNotPosted.selector, OTHER_EXAM_ID));
        vm.prank(BOARD);
        registry.postBuild(
            OTHER_EXAM_ID, listHash, PAPER_HASH, MANIFEST_HASH, SALTED_HASH, SELECTED, QUESTIONS, criteriaHash, sig, key
        );
    }

    // Exam settings

    function test_CreateExam_RejectsZeroValues() public {
        ExamRegistry.ExamSettings memory settings = _settings(bytes32(0));
        vm.startPrank(BOARD);
        vm.expectRevert(ExamRegistry.ZeroValue.selector);
        registry.createExam(COMMIT, DIGEST, settings, criteria);

        settings = _settings(EXAM_ID);
        vm.expectRevert(ExamRegistry.ZeroValue.selector);
        registry.createExam(bytes20(0), DIGEST, settings, criteria);
        vm.expectRevert(ExamRegistry.ZeroValue.selector);
        registry.createExam(COMMIT, bytes32(0), settings, criteria);

        settings.criteriaHash = bytes32(0);
        vm.expectRevert(ExamRegistry.ZeroValue.selector);
        registry.createExam(COMMIT, DIGEST, settings, criteria);
        vm.stopPrank();
    }

    function test_CreateExam_RejectsZeroDelta() public {
        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        settings.delta = 0;
        _expectCreateReverts(settings, ExamRegistry.ZeroValue.selector);
    }

    function test_CreateExam_RejectsEmptyRpcHost() public {
        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        settings.rpcHost = "";
        _expectCreateReverts(settings, ExamRegistry.ZeroValue.selector);
    }

    function test_CreateExam_RejectsRoundsOutOfOrder() public {
        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        settings.lockRound = 0;
        _expectCreateReverts(settings, ExamRegistry.InvalidRounds.selector);

        settings = _settings(EXAM_ID);
        settings.lockRound = UNLOCK_ROUND;
        _expectCreateReverts(settings, ExamRegistry.InvalidRounds.selector);

        settings = _settings(EXAM_ID);
        settings.endRound = UNLOCK_ROUND;
        _expectCreateReverts(settings, ExamRegistry.InvalidRounds.selector);

        settings = _settings(EXAM_ID);
        settings.endRound = 0;
        _expectCreateReverts(settings, ExamRegistry.InvalidRounds.selector);
    }

    function test_CreateExam_RejectsUnlockTimeNotAfterGenesis() public {
        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        settings.examStart = GENESIS + DELTA;
        _expectCreateReverts(settings, ExamRegistry.InvalidExamStart.selector);

        settings.examStart = GENESIS + DELTA - 1;
        _expectCreateReverts(settings, ExamRegistry.InvalidExamStart.selector);
    }

    function test_CreateExam_DeltaLargerThanExamStartDoesNotPanic() public {
        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        settings.delta = type(uint64).max;
        _expectCreateReverts(settings, ExamRegistry.InvalidExamStart.selector);

        settings = _settings(EXAM_ID);
        settings.examStart = 0;
        _expectCreateReverts(settings, ExamRegistry.InvalidExamStart.selector);
    }

    function test_CreateExam_AcceptsFirstSecondAfterGenesis() public {
        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        settings.delta = 1;
        settings.examStart = GENESIS + 2;
        settings.lockRound = 1;
        settings.unlockRound = 2;
        settings.endRound = 3;
        _createAccepted(settings);
    }

    function test_CreateExam_UnlockRound_OnARoundBoundary() public {
        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);

        settings.unlockRound = UNLOCK_ROUND - 1;
        _expectCreateReverts(
            settings, abi.encodeWithSelector(ExamRegistry.UnlockRoundMismatch.selector, UNLOCK_ROUND, UNLOCK_ROUND - 1)
        );

        settings.unlockRound = UNLOCK_ROUND + 1;
        _expectCreateReverts(
            settings, abi.encodeWithSelector(ExamRegistry.UnlockRoundMismatch.selector, UNLOCK_ROUND, UNLOCK_ROUND + 1)
        );

        settings.unlockRound = UNLOCK_ROUND;
        _createAccepted(settings);
    }

    function test_CreateExam_UnlockRound_RoundsUpBetweenRounds() public {
        for (uint64 offset = 1; offset <= 2; ++offset) {
            bytes32 examId = keccak256(abi.encode(offset));
            ExamRegistry.ExamSettings memory settings = _settings(examId);
            settings.examStart = EXAM_START + offset;

            // Rounding down would open the paper before T - delta.
            settings.unlockRound = UNLOCK_ROUND;
            _expectCreateReverts(
                settings,
                abi.encodeWithSelector(ExamRegistry.UnlockRoundMismatch.selector, UNLOCK_ROUND + 1, UNLOCK_ROUND)
            );

            settings.unlockRound = UNLOCK_ROUND + 2;
            _expectCreateReverts(
                settings,
                abi.encodeWithSelector(ExamRegistry.UnlockRoundMismatch.selector, UNLOCK_ROUND + 1, UNLOCK_ROUND + 2)
            );

            settings.unlockRound = UNLOCK_ROUND + 1;
            _createAccepted(settings);
        }
    }

    function testFuzz_CreateExam_UnlockRoundIsFirstAtOrAfterUnlockTime(uint64 examStart, uint64 delta) public {
        delta = uint64(bound(delta, 1, 30 days));
        examStart = uint64(bound(examStart, GENESIS + delta + 1, GENESIS + delta + 100 * 365 days));
        uint256 unlockTime = uint256(examStart) - delta;

        uint256 round = (unlockTime - GENESIS - 1) / 3 + 2;
        assertGe(GENESIS + (round - 1) * 3, unlockTime);
        assertLt(GENESIS + (round - 2) * 3, unlockTime);

        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        settings.examStart = examStart;
        settings.delta = delta;
        settings.lockRound = 1;
        settings.unlockRound = uint64(round);
        settings.endRound = type(uint64).max;
        _createAccepted(settings);
    }

    function test_CreateExam_EndRound_Boundary() public {
        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);

        // This round is produced exactly at examStart, which isn't after it.
        settings.endRound = FIRST_END_ROUND - 1;
        _expectCreateReverts(settings, ExamRegistry.InvalidEndRound.selector);

        settings.endRound = FIRST_END_ROUND;
        _createAccepted(settings);
    }

    function test_CreateExam_EndRound_BetweenRounds() public {
        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        settings.examStart = EXAM_START + 1;
        settings.unlockRound = UNLOCK_ROUND + 1;

        settings.endRound = FIRST_END_ROUND - 1;
        _expectCreateReverts(settings, ExamRegistry.InvalidEndRound.selector);

        settings.endRound = FIRST_END_ROUND;
        _createAccepted(settings);
    }

    function test_CreateExam_LargestEndRoundDoesNotOverflow() public {
        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        settings.endRound = type(uint64).max;
        _createAccepted(settings);
    }

    function test_CreateExam_StoresSettings() public {
        _create();
        ExamRegistry.ExamSettings memory stored = registry.getExam(EXAM_ID).settings;
        assertEq(stored.examStart, EXAM_START);
        assertEq(stored.delta, DELTA);
        assertEq(stored.lockRound, LOCK_ROUND);
        assertEq(stored.unlockRound, UNLOCK_ROUND);
        assertEq(stored.endRound, END_ROUND);
        assertEq(stored.criteriaHash, criteriaHash);
        assertEq(stored.rpcHost, RPC_HOST);
    }

    // Selection criteria

    function test_CreateExam_CriteriaHashMatchesKnownAnswer() public {
        bytes memory encoded = hex"00000001ab";
        // Preimage and digest computed outside Solidity: built word by word in Python, hashed with hashlib, and
        // checked against `cast abi-encode "f(string,bytes)"`.
        bytes memory preimage =
            hex"00000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000001570617065727365616c2f76312f63726974657269610000000000000000000000000000000000000000000000000000000000000000000000000000000000000500000001ab000000000000000000000000000000000000000000000000000000";
        bytes32 expected = hex"043108b297ca82c2bc2760d6026eb4a5f6f646d3ed72a641e3f5cf83b26ab3c4";
        assertEq(sha256(preimage), expected);

        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        settings.criteriaHash = expected;
        vm.prank(BOARD);
        registry.createExam(COMMIT, DIGEST, settings, encoded);
        assertEq(registry.getExam(EXAM_ID).settings.criteriaHash, expected);
    }

    function test_CreateExam_CriteriaHashMatchesEncodedCriteriaWithSpecTag() public {
        string memory tag = vm.parseJsonString(_constants(), ".domainTags.criteria");
        bytes memory encoded = abi.encode(_sampleCriteria());

        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        settings.criteriaHash = sha256(abi.encode(tag, encoded));
        vm.prank(BOARD);
        registry.createExam(COMMIT, DIGEST, settings, encoded);
        assertEq(registry.getExam(EXAM_ID).settings.criteriaHash, settings.criteriaHash);

        Criteria memory decoded = abi.decode(encoded, (Criteria));
        assertEq(decoded.topics.length, 2);
        assertEq(decoded.topics[0].questions + decoded.topics[1].questions, SELECTED);
    }

    function test_CreateExam_RejectsCriteriaHashMismatch() public {
        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        settings.criteriaHash = OTHER;
        _expectCreateReverts(
            settings, abi.encodeWithSelector(ExamRegistry.CriteriaHashMismatch.selector, OTHER, criteriaHash)
        );
        assertEq(registry.getExam(EXAM_ID).createdAt, 0);
    }

    function test_CreateExam_RejectsCriteriaBytesThatDiffer() public {
        bytes memory altered = abi.encodePacked(criteria, bytes1(0));
        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        bytes memory reason = abi.encodeWithSelector(
            ExamRegistry.CriteriaHashMismatch.selector, criteriaHash, _expectedCriteriaHash(altered)
        );
        vm.expectRevert(reason);
        vm.prank(BOARD);
        registry.createExam(COMMIT, DIGEST, settings, altered);
    }

    function test_CreateExam_RejectsEmptyCriteria() public {
        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        vm.expectRevert(ExamRegistry.ZeroValue.selector);
        vm.prank(BOARD);
        registry.createExam(COMMIT, DIGEST, settings, "");
    }

    function test_CreateExam_DoesNotDecodeCriteria() public {
        bytes memory malformed = hex"ff";
        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        settings.criteriaHash = _expectedCriteriaHash(malformed);
        vm.prank(BOARD);
        registry.createExam(COMMIT, DIGEST, settings, malformed);
        assertEq(registry.getExam(EXAM_ID).settings.criteriaHash, settings.criteriaHash);
    }

    // Approved list

    function test_PostApprovedList_HashMatchesKnownAnswer() public {
        bytes32 examId = hex"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
        bytes memory list = hex"00000001ab";
        // Preimage and digest computed outside Solidity: built word by word in Python, hashed with hashlib, and
        // checked against `cast abi-encode "f(string,bytes32,bytes)"`.
        bytes memory preimage =
            hex"00000000000000000000000000000000000000000000000000000000000000600102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000001a70617065727365616c2f76312f617070726f7665642d6c697374000000000000000000000000000000000000000000000000000000000000000000000000000500000001ab000000000000000000000000000000000000000000000000000000";
        bytes32 expected = hex"fcac024694ab1c2b0cacd534f82b2d0d30e14935b11df9e8f8317153b839b61f";
        assertEq(sha256(preimage), expected);

        ExamRegistry.ExamSettings memory settings = _settings(examId);
        vm.startPrank(BOARD);
        registry.createExam(COMMIT, DIGEST, settings, criteria);
        registry.postApprovedList(examId, list);
        vm.stopPrank();

        assertEq(registry.getApprovedList(examId).listHash, expected);
    }

    function test_PostApprovedList_HashUsesSpecTag() public {
        string memory tag = vm.parseJsonString(_constants(), ".domainTags.approvedList");
        bytes memory list = _filled(0xAB, 300);
        bytes32 expected = sha256(abi.encode(tag, EXAM_ID, list));

        _create();
        vm.prank(BOARD);
        registry.postApprovedList(EXAM_ID, list);
        assertEq(registry.getApprovedList(EXAM_ID).listHash, expected);
    }

    function test_PostApprovedList_HashMatchesEncodedEntryArray() public {
        string memory tag = vm.parseJsonString(_constants(), ".domainTags.approvedList");
        // Per spec/api.md the `entries` field is `bytes` holding abi.encode(Entry[]), not the array inline.
        bytes memory list = abi.encode(_sampleEntries());
        bytes32 expected = sha256(abi.encode(tag, EXAM_ID, list));

        _create();
        vm.prank(BOARD);
        registry.postApprovedList(EXAM_ID, list);
        assertEq(registry.getApprovedList(EXAM_ID).listHash, expected);

        Entry[] memory decoded = abi.decode(list, (Entry[]));
        assertEq(decoded.length, 2);
        assertEq(decoded[1].owner, "Centre 12");
    }

    function test_PostApprovedList_HashBindsExamId() public {
        _postList();
        vm.startPrank(BOARD);
        registry.createExam(COMMIT, DIGEST, _settings(OTHER_EXAM_ID), criteria);
        registry.postApprovedList(OTHER_EXAM_ID, entries);
        vm.stopPrank();
        assertNotEq(registry.getApprovedList(OTHER_EXAM_ID).listHash, registry.getApprovedList(EXAM_ID).listHash);
    }

    function test_PostApprovedList_RejectsEmptyEntries() public {
        _create();
        vm.expectRevert(ExamRegistry.ZeroValue.selector);
        vm.prank(BOARD);
        registry.postApprovedList(EXAM_ID, "");
    }

    function test_PostApprovedList_DoesNotDecodeEntries() public {
        _create();
        bytes memory malformed = hex"ff";
        vm.prank(BOARD);
        registry.postApprovedList(EXAM_ID, malformed);
        assertEq(registry.getApprovedList(EXAM_ID).listHash, _expectedListHash(EXAM_ID, malformed));
    }

    // Build

    function test_PostBuild_RejectsApprovedListHashMismatch() public {
        _postList();
        vm.expectRevert(abi.encodeWithSelector(ExamRegistry.ApprovedListHashMismatch.selector, listHash, OTHER));
        vm.prank(BOARD);
        registry.postBuild(
            EXAM_ID, OTHER, PAPER_HASH, MANIFEST_HASH, SALTED_HASH, SELECTED, QUESTIONS, criteriaHash, sig, key
        );
    }

    function test_PostBuild_RejectsCriteriaHashMismatch() public {
        _postList();
        vm.expectRevert(abi.encodeWithSelector(ExamRegistry.CriteriaHashMismatch.selector, criteriaHash, OTHER));
        vm.prank(BOARD);
        registry.postBuild(
            EXAM_ID, listHash, PAPER_HASH, MANIFEST_HASH, SALTED_HASH, SELECTED, QUESTIONS, OTHER, sig, key
        );
    }

    function test_PostBuild_RejectsInvalidCounts() public {
        _postList();
        vm.startPrank(BOARD);
        vm.expectRevert(ExamRegistry.InvalidSelection.selector);
        registry.postBuild(
            EXAM_ID, listHash, PAPER_HASH, MANIFEST_HASH, SALTED_HASH, 0, QUESTIONS, criteriaHash, sig, key
        );
        vm.expectRevert(ExamRegistry.InvalidSelection.selector);
        registry.postBuild(
            EXAM_ID, listHash, PAPER_HASH, MANIFEST_HASH, SALTED_HASH, QUESTIONS + 1, QUESTIONS, criteriaHash, sig, key
        );
        registry.postBuild(
            EXAM_ID, listHash, PAPER_HASH, MANIFEST_HASH, SALTED_HASH, QUESTIONS, QUESTIONS, criteriaHash, sig, key
        );
        vm.stopPrank();
    }

    function test_PostBuild_RejectsZeroHashes() public {
        _postList();
        vm.startPrank(BOARD);
        vm.expectRevert(ExamRegistry.ZeroValue.selector);
        registry.postBuild(
            EXAM_ID, listHash, bytes32(0), MANIFEST_HASH, SALTED_HASH, SELECTED, QUESTIONS, criteriaHash, sig, key
        );
        vm.expectRevert(ExamRegistry.ZeroValue.selector);
        registry.postBuild(
            EXAM_ID, listHash, PAPER_HASH, bytes32(0), SALTED_HASH, SELECTED, QUESTIONS, criteriaHash, sig, key
        );
        vm.expectRevert(ExamRegistry.ZeroValue.selector);
        registry.postBuild(
            EXAM_ID, listHash, PAPER_HASH, MANIFEST_HASH, bytes32(0), SELECTED, QUESTIONS, criteriaHash, sig, key
        );
        vm.stopPrank();
    }

    function test_PostBuild_RejectsBadSignatureLength() public {
        _postList();
        bytes memory shortSig = _filled(0x11, 63);
        bytes memory longSig = _filled(0x11, 65);
        vm.startPrank(BOARD);
        vm.expectRevert(ExamRegistry.InvalidSignatureLength.selector);
        registry.postBuild(
            EXAM_ID, listHash, PAPER_HASH, MANIFEST_HASH, SALTED_HASH, SELECTED, QUESTIONS, criteriaHash, shortSig, key
        );
        vm.expectRevert(ExamRegistry.InvalidSignatureLength.selector);
        registry.postBuild(
            EXAM_ID, listHash, PAPER_HASH, MANIFEST_HASH, SALTED_HASH, SELECTED, QUESTIONS, criteriaHash, longSig, key
        );
        vm.stopPrank();
    }

    function test_PostBuild_RejectsBadInstanceKey() public {
        _postList();
        bytes memory compressed = _filled(0x02, 33);
        bytes memory wrongPrefix = _filled(0x03, 65);
        vm.startPrank(BOARD);
        vm.expectRevert(ExamRegistry.InvalidPublicKey.selector);
        registry.postBuild(
            EXAM_ID,
            listHash,
            PAPER_HASH,
            MANIFEST_HASH,
            SALTED_HASH,
            SELECTED,
            QUESTIONS,
            criteriaHash,
            sig,
            compressed
        );
        vm.expectRevert(ExamRegistry.InvalidPublicKey.selector);
        registry.postBuild(
            EXAM_ID,
            listHash,
            PAPER_HASH,
            MANIFEST_HASH,
            SALTED_HASH,
            SELECTED,
            QUESTIONS,
            criteriaHash,
            sig,
            wrongPrefix
        );
        vm.stopPrank();
    }

    function test_Signatures_AreStoredNotVerified() public {
        _postList();
        bytes memory garbage = _filled(0xFF, 64);
        vm.prank(BOARD);
        registry.postBuild(
            EXAM_ID, listHash, PAPER_HASH, MANIFEST_HASH, SALTED_HASH, SELECTED, QUESTIONS, criteriaHash, garbage, key
        );
        assertEq(registry.getBuild(EXAM_ID).teeSignature, garbage);
    }

    // Events

    function test_CreateExam_EmitsEvent() public {
        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        vm.expectEmit(true, true, true, true, address(registry));
        emit ExamRegistry.ExamCreated(
            EXAM_ID,
            COMMIT,
            DIGEST,
            EXAM_START,
            DELTA,
            LOCK_ROUND,
            UNLOCK_ROUND,
            END_ROUND,
            criteriaHash,
            RPC_HOST,
            criteria
        );
        vm.prank(BOARD);
        registry.createExam(COMMIT, DIGEST, settings, criteria);
    }

    function test_PostApprovedList_EmitsEvent() public {
        _create();
        vm.expectEmit(true, true, true, true, address(registry));
        emit ExamRegistry.ApprovedListPosted(EXAM_ID, listHash, entries);
        vm.prank(BOARD);
        registry.postApprovedList(EXAM_ID, entries);
    }

    function test_PostBuild_EmitsEvent() public {
        _postList();
        vm.expectEmit(true, true, true, true, address(registry));
        emit ExamRegistry.BuildPosted(
            EXAM_ID, listHash, PAPER_HASH, MANIFEST_HASH, SALTED_HASH, SELECTED, QUESTIONS, criteriaHash, sig, key
        );
        vm.prank(BOARD);
        _build();
    }

    function test_ExamId_IsIndexedInEveryEvent() public {
        vm.recordLogs();
        _postBuild();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 3);
        for (uint256 i; i < logs.length; ++i) {
            assertEq(logs[i].topics.length, 2);
            assertEq(logs[i].topics[1], EXAM_ID);
        }
    }

    // Stored blocks

    /// @dev Vm.Log has no block number, so each write is recorded on its own block and its log drained there.
    function _assertOneLogHere(bytes32 topic) internal view {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(registry));
        assertEq(logs[0].topics[0], topic);
        assertEq(logs[0].topics[1], EXAM_ID);
    }

    function test_StoredBlocks_AreTheBlocksOfTheEvents() public {
        uint64 createdBlock = 9_000_000;
        // Above 2^32, so a narrower cast would show.
        uint64 postedBlock = 5_000_000_000;
        vm.recordLogs();

        vm.roll(createdBlock);
        _create();
        _assertOneLogHere(ExamRegistry.ExamCreated.selector);
        assertEq(registry.getExam(EXAM_ID).createdBlock, createdBlock);

        vm.roll(postedBlock);
        vm.prank(BOARD);
        registry.postApprovedList(EXAM_ID, entries);
        _assertOneLogHere(ExamRegistry.ApprovedListPosted.selector);
        assertEq(registry.getApprovedList(EXAM_ID).postedBlock, postedBlock);

        vm.roll(postedBlock + 50_000);
        vm.prank(BOARD);
        _build();

        assertEq(registry.getExam(EXAM_ID).createdBlock, createdBlock);
        assertEq(registry.getApprovedList(EXAM_ID).postedBlock, postedBlock);
    }

    function test_StoredBlocks_ArePerExam() public {
        vm.roll(100);
        _create();
        vm.roll(200);
        ExamRegistry.ExamSettings memory settings = _settings(OTHER_EXAM_ID);
        vm.prank(BOARD);
        registry.createExam(COMMIT, DIGEST, settings, criteria);

        assertEq(registry.getExam(EXAM_ID).createdBlock, 100);
        assertEq(registry.getExam(OTHER_EXAM_ID).createdBlock, 200);
    }

    // Views

    function test_Views_ReturnStoredRecords() public {
        _postBuild();
        uint64 at = uint64(block.timestamp);
        uint64 blockNumber = uint64(block.number);

        ExamRegistry.Exam memory exam = registry.getExam(EXAM_ID);
        ExamRegistry.ExamSettings memory expected = _settings(EXAM_ID);
        assertEq(exam.commitHash, COMMIT);
        assertEq(exam.imageDigest, DIGEST);
        assertEq(exam.createdAt, at);
        assertEq(exam.createdBlock, blockNumber);
        assertEq(abi.encode(exam.settings), abi.encode(expected));

        ExamRegistry.ApprovedList memory list = registry.getApprovedList(EXAM_ID);
        assertEq(list.listHash, listHash);
        assertEq(list.postedAt, at);
        assertEq(list.postedBlock, blockNumber);

        ExamRegistry.Build memory build = registry.getBuild(EXAM_ID);
        assertEq(build.approvedListHash, listHash);
        assertEq(build.paperHash, PAPER_HASH);
        assertEq(build.storageManifestHash, MANIFEST_HASH);
        assertEq(build.saltedPaperHash, SALTED_HASH);
        assertEq(build.selected, SELECTED);
        assertEq(build.bankSize, QUESTIONS);
        assertEq(build.postedAt, at);
        assertEq(build.criteriaHash, criteriaHash);
        assertEq(build.teeSignature, sig);
        assertEq(build.instancePublicKey, key);
    }

    function test_Views_ReturnEmptyRecordsBeforePosting() public view {
        assertEq(registry.getExam(EXAM_ID).createdAt, 0);
        assertEq(registry.getExam(EXAM_ID).createdBlock, 0);
        assertEq(registry.getApprovedList(EXAM_ID).postedAt, 0);
        assertEq(registry.getApprovedList(EXAM_ID).postedBlock, 0);
        assertEq(registry.getBuild(EXAM_ID).postedAt, 0);
    }

    // Deployment

    function test_DeployScript_ReadsBoardFromEnv() public {
        vm.setEnv("BOARD_ADDRESS", vm.toString(BOARD));
        ExamRegistry deployed = new Deploy().run();
        assertEq(deployed.board(), BOARD);
    }
}

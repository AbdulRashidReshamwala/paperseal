// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test, Vm} from "forge-std/Test.sol";
import {ExamRegistry} from "../src/ExamRegistry.sol";

/// @dev Helpers for the audit's test gaps, with literal quicknet timing, separate from the contract's constants.
abstract contract AuditBase is Test {
    address internal constant BOARD = address(0xB0A2D);
    uint64 internal constant GENESIS = 1692803367;
    bytes32 internal constant EXAM_ID = keccak256("Physics Paper 1, June 2027");
    bytes32 internal constant OTHER_EXAM_ID = keccak256("Physics Paper 2, June 2027");
    bytes20 internal constant COMMIT = bytes20(keccak256("commit"));
    bytes32 internal constant DIGEST = keccak256("digest");
    bytes32 internal constant HASH = keccak256("hash");
    bytes internal constant CRITERIA = hex"00000001ab";

    ExamRegistry internal registry;

    function setUp() public virtual {
        registry = new ExamRegistry(BOARD);
        vm.warp(1_800_000_000);
    }

    function _criteriaHash(bytes memory criteria) internal pure returns (bytes32) {
        string memory tag = "paperseal/v1/criteria";
        return sha256(abi.encode(tag, criteria));
    }

    function _listHash(bytes32 examId, bytes memory entries) internal pure returns (bytes32) {
        string memory tag = "paperseal/v1/approved-list";
        return sha256(abi.encode(tag, examId, entries));
    }

    function _settings(bytes32 examId) internal view returns (ExamRegistry.ExamSettings memory) {
        uint64 start = uint64(block.timestamp) + 30 days;
        uint64 delta = 3600;
        uint64 unlock = (start - delta - GENESIS + 2) / 3 + 1;
        return ExamRegistry.ExamSettings(
            examId, start, delta, unlock - 1000, unlock, unlock + 4000, _criteriaHash(CRITERIA), "rpc.example.org"
        );
    }

    function _create(bytes32 examId) internal returns (ExamRegistry.ExamSettings memory settings) {
        settings = _settings(examId);
        vm.prank(BOARD);
        registry.createExam(COMMIT, DIGEST, settings, CRITERIA);
    }

    function _key() internal pure returns (bytes memory key) {
        key = new bytes(65);
        key[0] = 0x04;
    }
}

contract ExamRegistryAuditTest is AuditBase {
    uint64 internal constant BUILT_ROUND = 1000;

    function _keyOfLength(uint256 length) internal pure returns (bytes memory key) {
        key = new bytes(length);
        key[0] = 0x04;
    }

    function _postBuildWithKey(bytes memory key) internal {
        bytes32 hash = _create(EXAM_ID).criteriaHash;
        bytes memory entries = hex"01";
        vm.prank(BOARD);
        registry.postApprovedList(EXAM_ID, entries);
        bytes32 listHash = _listHash(EXAM_ID, entries);
        vm.prank(BOARD);
        vm.expectRevert(ExamRegistry.InvalidPublicKey.selector);
        registry.postBuild(
            EXAM_ID,
            ExamRegistry.BuildFields(listHash, HASH, HASH, HASH, 20, 200, hash, BUILT_ROUND),
            new bytes(64),
            key
        );
    }

    function test_PostBuild_RejectsShortKeyWithRightPrefix() public {
        _postBuildWithKey(_keyOfLength(64));
    }

    function test_PostBuild_RejectsLongKeyWithRightPrefix() public {
        _postBuildWithKey(_keyOfLength(66));
    }

    /// @dev The criteria hash is wrong too, so `CriteriaHashMismatch` would show if hashing came first.
    function test_CreateExam_TooLargeCriteriaRevertsBeforeHashing() public {
        bytes memory big = new bytes(16385);
        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        settings.criteriaHash = keccak256("not the hash of these criteria");
        vm.prank(BOARD);
        vm.expectRevert(ExamRegistry.CriteriaTooLarge.selector);
        registry.createExam(COMMIT, DIGEST, settings, big);
    }

    /// @dev Hashing 4 MiB costs about 1.5 million gas in the sha256 precompile alone, so a call with 300,000
    ///      gas only gets this far with this reason if it never hashes.
    function test_CreateExam_HugeCriteriaRevertsWithoutPayingToHash() public {
        bytes memory huge = new bytes(4 << 20);
        ExamRegistry.ExamSettings memory settings = _settings(EXAM_ID);
        bytes memory call = abi.encodeCall(ExamRegistry.createExam, (COMMIT, DIGEST, settings, huge));
        vm.prank(BOARD);
        (bool ok, bytes memory reason) = address(registry).call{gas: 300_000}(call);
        assertFalse(ok);
        assertEq(bytes4(reason), ExamRegistry.CriteriaTooLarge.selector);
    }

    function test_PostBuild_RejectsAnotherExamsListHash() public {
        bytes32 hash = _create(EXAM_ID).criteriaHash;
        _create(OTHER_EXAM_ID);
        bytes memory entries = hex"01";
        vm.startPrank(BOARD);
        registry.postApprovedList(EXAM_ID, entries);
        registry.postApprovedList(OTHER_EXAM_ID, entries);
        vm.stopPrank();

        // One list, but the hash covers the exam ID, so each exam's hash is its own.
        bytes32 own = _listHash(EXAM_ID, entries);
        bytes32 other = _listHash(OTHER_EXAM_ID, entries);
        assertNotEq(own, other);
        vm.prank(BOARD);
        vm.expectRevert(abi.encodeWithSelector(ExamRegistry.ApprovedListHashMismatch.selector, own, other));
        registry.postBuild(
            EXAM_ID,
            ExamRegistry.BuildFields(other, HASH, HASH, HASH, 20, 200, hash, BUILT_ROUND),
            new bytes(64),
            _key()
        );
        assertEq(registry.getBuild(EXAM_ID).postedAt, 0);
    }

    /// @dev Readers query one block with examId as a topic, so two exams in that block must stay apart.
    function test_SeveralExamsInOneBlock() public {
        _create(EXAM_ID);
        _create(OTHER_EXAM_ID);
        assertEq(registry.getExam(EXAM_ID).createdBlock, registry.getExam(OTHER_EXAM_ID).createdBlock);

        vm.recordLogs();
        vm.startPrank(BOARD);
        registry.postApprovedList(EXAM_ID, hex"01");
        registry.postApprovedList(OTHER_EXAM_ID, hex"02");
        vm.expectRevert(abi.encodeWithSelector(ExamRegistry.ApprovedListAlreadyPosted.selector, EXAM_ID));
        registry.postApprovedList(EXAM_ID, hex"03");
        vm.stopPrank();

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2);
        uint256 forExam;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[1] == EXAM_ID) {
                ++forExam;
                (bytes32 listHash, bytes memory entries) = abi.decode(logs[i].data, (bytes32, bytes));
                assertEq(entries, hex"01");
                assertEq(listHash, registry.getApprovedList(EXAM_ID).listHash);
            }
        }
        assertEq(forExam, 1);
        assertEq(registry.getApprovedList(EXAM_ID).postedBlock, registry.getApprovedList(OTHER_EXAM_ID).postedBlock);
        assertNotEq(registry.getApprovedList(EXAM_ID).listHash, registry.getApprovedList(OTHER_EXAM_ID).listHash);
    }
}

/// @dev Random writes against a few exam IDs, keeping the first value written to each slot.
contract WriteOnceHandler is Test {
    uint64 internal constant BUILT_ROUND = 1000;
    address internal constant BOARD = address(0xB0A2D);
    uint64 internal constant GENESIS = 1692803367;

    ExamRegistry public immutable registry;
    bytes32[3] public ids = [keccak256("a"), keccak256("b"), keccak256("c")];
    mapping(bytes32 examId => bytes) public firstExam;
    mapping(bytes32 examId => bytes32) public firstList;
    mapping(bytes32 examId => bytes32) public firstBuild;

    constructor(ExamRegistry registry_) {
        registry = registry_;
    }

    function create(uint8 which, uint64 seed) external {
        bytes32 examId = ids[which % 3];
        uint64 delta = 3600;
        uint64 start = 1_800_000_000 + 3 * uint64(bound(seed, 1, 1e9));
        uint64 unlock = (start - delta - GENESIS + 2) / 3 + 1;
        bytes memory criteria = abi.encode(seed);
        string memory tag = "paperseal/v1/criteria";
        ExamRegistry.ExamSettings memory settings = ExamRegistry.ExamSettings(
            examId, start, delta, 1, unlock, unlock + 5000, sha256(abi.encode(tag, criteria)), "rpc.example.org"
        );
        vm.prank(BOARD);
        try registry.createExam(bytes20(keccak256(criteria)), keccak256(criteria), settings, criteria) {
            firstExam[examId] = abi.encode(registry.getExam(examId));
        } catch {}
    }

    function list(uint8 which, bytes calldata entries) external {
        bytes32 examId = ids[which % 3];
        vm.prank(BOARD);
        try registry.postApprovedList(examId, entries) {
            firstList[examId] = registry.getApprovedList(examId).listHash;
        } catch {}
    }

    function build(uint8 which, bytes32 paper) external {
        bytes32 examId = ids[which % 3];
        if (paper == bytes32(0)) paper = keccak256("paper");
        bytes memory key = new bytes(65);
        key[0] = 0x04;
        bytes32 listHash = registry.getApprovedList(examId).listHash;
        bytes32 criteriaHash = registry.getExam(examId).settings.criteriaHash;
        vm.prank(BOARD);
        try registry.postBuild(
            examId,
            ExamRegistry.BuildFields(listHash, paper, paper, paper, 1, 1, criteriaHash, BUILT_ROUND),
            new bytes(64),
            key
        ) {
            firstBuild[examId] = paper;
        } catch {}
    }
}

contract ExamRegistryWriteOnceInvariant is Test {
    ExamRegistry internal registry;
    WriteOnceHandler internal handler;

    function setUp() public {
        registry = new ExamRegistry(address(0xB0A2D));
        handler = new WriteOnceHandler(registry);
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 32
    /// forge-config: default.invariant.depth = 64
    function invariant_FirstWriteStands() public view {
        for (uint256 i; i < 3; ++i) {
            bytes32 examId = handler.ids(i);
            bytes memory exam = handler.firstExam(examId);
            if (exam.length != 0) assertEq(abi.encode(registry.getExam(examId)), exam);
            if (handler.firstList(examId) != 0) {
                assertEq(registry.getApprovedList(examId).listHash, handler.firstList(examId));
            }
            if (handler.firstBuild(examId) != 0) {
                assertEq(registry.getBuild(examId).paperHash, handler.firstBuild(examId));
            }
        }
    }

    /// forge-config: default.invariant.runs = 32
    /// forge-config: default.invariant.depth = 64
    function invariant_RecordsKeepTheirOrder() public view {
        for (uint256 i; i < 3; ++i) {
            bytes32 examId = handler.ids(i);
            if (registry.getBuild(examId).postedAt != 0) assertGt(registry.getApprovedList(examId).postedAt, 0);
            if (registry.getApprovedList(examId).postedAt != 0) assertGt(registry.getExam(examId).createdAt, 0);
        }
    }
}

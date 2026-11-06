package chainread

import (
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
)

// The ExamRegistry getters and events the TEE uses, copied from
// contracts/src/ExamRegistry.sol. Only what is read is listed.
const registryABIJSON = `[
 {"type":"function","name":"getExam","stateMutability":"view","inputs":[{"name":"examId","type":"bytes32"}],
  "outputs":[{"name":"","type":"tuple","components":[
    {"name":"commitHash","type":"bytes20"},{"name":"imageDigest","type":"bytes32"},
    {"name":"createdAt","type":"uint64"},{"name":"createdBlock","type":"uint64"},
    {"name":"settings","type":"tuple","components":[
      {"name":"examId","type":"bytes32"},{"name":"examStart","type":"uint64"},{"name":"delta","type":"uint64"},
      {"name":"lockRound","type":"uint64"},{"name":"unlockRound","type":"uint64"},{"name":"endRound","type":"uint64"},
      {"name":"criteriaHash","type":"bytes32"},{"name":"rpcHost","type":"string"}]}]}]},
 {"type":"function","name":"getApprovedList","stateMutability":"view","inputs":[{"name":"examId","type":"bytes32"}],
  "outputs":[{"name":"","type":"tuple","components":[
    {"name":"listHash","type":"bytes32"},{"name":"postedAt","type":"uint64"},{"name":"postedBlock","type":"uint64"}]}]},
 {"type":"function","name":"getBuild","stateMutability":"view","inputs":[{"name":"examId","type":"bytes32"}],
  "outputs":[{"name":"","type":"tuple","components":[
    {"name":"approvedListHash","type":"bytes32"},{"name":"paperHash","type":"bytes32"},
    {"name":"storageManifestHash","type":"bytes32"},{"name":"saltedPaperHash","type":"bytes32"},
    {"name":"selected","type":"uint32"},{"name":"bankSize","type":"uint32"},{"name":"builtRound","type":"uint64"},{"name":"postedAt","type":"uint64"},
    {"name":"criteriaHash","type":"bytes32"},{"name":"teeSignature","type":"bytes"},{"name":"instancePublicKey","type":"bytes"}]}]},
 {"type":"event","name":"ExamCreated","anonymous":false,"inputs":[
    {"name":"examId","type":"bytes32","indexed":true},{"name":"commitHash","type":"bytes20","indexed":false},
    {"name":"imageDigest","type":"bytes32","indexed":false},{"name":"examStart","type":"uint64","indexed":false},
    {"name":"delta","type":"uint64","indexed":false},{"name":"lockRound","type":"uint64","indexed":false},
    {"name":"unlockRound","type":"uint64","indexed":false},{"name":"endRound","type":"uint64","indexed":false},
    {"name":"criteriaHash","type":"bytes32","indexed":false},{"name":"rpcHost","type":"string","indexed":false},
    {"name":"criteria","type":"bytes","indexed":false}]},
 {"type":"event","name":"ApprovedListPosted","anonymous":false,"inputs":[
    {"name":"examId","type":"bytes32","indexed":true},{"name":"listHash","type":"bytes32","indexed":false},
    {"name":"entries","type":"bytes","indexed":false}]}
]`

var registryABI = func() abi.ABI {
	a, err := abi.JSON(strings.NewReader(registryABIJSON))
	if err != nil {
		panic("chainread: " + err.Error())
	}
	return a
}()

type examTuple struct {
	CommitHash   [20]byte
	ImageDigest  [32]byte
	CreatedAt    uint64
	CreatedBlock uint64
	Settings     struct {
		ExamId       [32]byte
		ExamStart    uint64
		Delta        uint64
		LockRound    uint64
		UnlockRound  uint64
		EndRound     uint64
		CriteriaHash [32]byte
		RpcHost      string
	}
}

type listTuple struct {
	ListHash    [32]byte
	PostedAt    uint64
	PostedBlock uint64
}

type buildTuple struct {
	ApprovedListHash    [32]byte
	PaperHash           [32]byte
	StorageManifestHash [32]byte
	SaltedPaperHash     [32]byte
	Selected            uint32
	BankSize            uint32
	BuiltRound          uint64
	PostedAt            uint64
	CriteriaHash        [32]byte
	TeeSignature        []byte
	InstancePublicKey   []byte
}

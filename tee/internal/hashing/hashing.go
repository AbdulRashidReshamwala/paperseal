// Package hashing is the domain-tagged hash encoding from spec/api.md. Every
// language must produce the same bytes, and testdata/vectors.json pins them.
//
// A message is SHA-256(abi.encode(string tag, field, ...)) in Solidity's
// standard ABI encoding. go-ethereum writes the bytes, so none of the encoding
// is written by hand here.
package hashing

import (
	"crypto/ecdh"
	"crypto/sha256"
	"errors"
	"fmt"

	"github.com/ethereum/go-ethereum/accounts/abi"

	"paperseal/tee/internal/spec"
)

// PublicKeyBytes is the length of an uncompressed P-256 public key.
const PublicKeyBytes = 65

var (
	stringType  = abiType("string")
	bytes32Type = abiType("bytes32")
	bytesType   = abiType("bytes")
	uint32Type  = abiType("uint32")
)

func abiType(name string) abi.Type {
	t, err := abi.NewType(name, "", nil)
	if err != nil {
		panic("hashing: " + err.Error())
	}
	return t
}

// Field is one named field of a message.
type Field struct {
	Name  string
	Type  abi.Type
	Value any // [32]byte, []byte or uint32, to suit Type.
}

// Bytes32 is a fixed 32-byte field.
func Bytes32(name string, b [32]byte) Field { return Field{name, bytes32Type, b} }

// String is a text field, such as a setter's name.
func String(name, s string) Field { return Field{name, stringType, s} }

// Bytes is a variable-length field, which includes public keys.
func Bytes(name string, b []byte) Field { return Field{name, bytesType, b} }

// Uint32 is a count, such as selected or bankSize.
func Uint32(name string, v uint32) Field { return Field{name, uint32Type, v} }

// Message is a tagged list of fields with its encoding.
type Message struct {
	Name    string
	Tag     string
	Fields  []Field
	encoded []byte
}

// New builds a message and encodes it.
func New(name, tag string, fields ...Field) (Message, error) {
	args := abi.Arguments{{Type: stringType}}
	values := []any{tag}
	for _, f := range fields {
		args = append(args, abi.Argument{Type: f.Type})
		values = append(values, f.Value)
	}
	encoded, err := args.Pack(values...)
	if err != nil {
		return Message{}, fmt.Errorf("hashing: encode %s: %w", name, err)
	}
	return Message{name, tag, fields, encoded}, nil
}

// Encode returns the exact bytes that are hashed.
func (m Message) Encode() []byte { return m.encoded }

// Sum returns the SHA-256 digest of the encoded message.
func (m Message) Sum() [32]byte { return sha256.Sum256(m.encoded) }

// CheckPublicKey requires a 65-byte uncompressed point on P-256.
func CheckPublicKey(key []byte) error {
	if len(key) != PublicKeyBytes || key[0] != 0x04 {
		return errors.New("hashing: public key must be a 65-byte uncompressed point starting with 0x04")
	}
	if _, err := ecdh.P256().NewPublicKey(key); err != nil {
		return fmt.Errorf("hashing: public key is not on P-256: %w", err)
	}
	return nil
}

func checkKeys(name string, keys ...[]byte) error {
	for _, key := range keys {
		if err := CheckPublicKey(key); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
	}
	return nil
}

// AttestationNonce is the preimage of eat_nonce.
func AttestationNonce(instancePublicKey []byte, examID [32]byte) (Message, error) {
	if err := checkKeys("attestationNonce", instancePublicKey); err != nil {
		return Message{}, err
	}
	return New("attestationNonce", spec.C.DomainTags.AttestationNonce,
		Bytes("instancePublicKey", instancePublicKey),
		Bytes32("examId", examID))
}

// InstanceKey is the message the TEE's signing key signs over its separate
// encryption key. Apps verify it before encrypting anything to the TEE.
func InstanceKey(examID [32]byte, encryptionPublicKey []byte) (Message, error) {
	if err := checkKeys("instanceKey", encryptionPublicKey); err != nil {
		return Message{}, err
	}
	return New("instanceKey", spec.C.DomainTags.InstanceKey,
		Bytes32("examId", examID),
		Bytes("encryptionPublicKey", encryptionPublicKey))
}

// SetterOwner is the public hash of a setter's own passkey public key. Its Sum
// is the setter's owner on the approved list, as lowercase 0x hex. Setter names
// are never published, and anyone can recompute this from the list.
func SetterOwner(passkeyPublicKey []byte) (Message, error) {
	if err := checkKeys("setterOwner", passkeyPublicKey); err != nil {
		return Message{}, err
	}
	return New("setterOwner", spec.C.DomainTags.SetterOwner,
		Bytes("passkeyPublicKey", passkeyPublicKey))
}

// Registration is the message a passkey signs at registration. A setter
// registers a passkey only, so derivedPublicKey is empty for setters and a
// valid public key for everyone else.
func Registration(derivedPublicKey, holderID, challenge []byte) (Message, error) {
	if len(derivedPublicKey) != 0 {
		if err := checkKeys("registration", derivedPublicKey); err != nil {
			return Message{}, err
		}
	}
	return New("registration", spec.C.DomainTags.Registration,
		Bytes("derivedPublicKey", derivedPublicKey),
		Bytes("holderId", holderID),
		Bytes("challenge", challenge))
}

// Criteria commits to the encoded selection criteria. Its Sum is criteriaHash.
func Criteria(criteria []byte) (Message, error) {
	return New("criteria", spec.C.DomainTags.Criteria, Bytes("criteria", criteria))
}

// ApprovedList commits to the encoded list, as posted to ExamRegistry. Its Sum
// is approvedListHash, which the contract computes from the same bytes.
func ApprovedList(examID [32]byte, entries []byte) (Message, error) {
	return New("approvedList", spec.C.DomainTags.ApprovedList,
		Bytes32("examId", examID),
		Bytes("entries", entries))
}

// QuestionSubmission is the message a setter's passkey signs. questionHash is
// the plain SHA-256 of the question ciphertext, never of the plaintext.
func QuestionSubmission(examID [32]byte, challenge []byte, questionHash [32]byte) (Message, error) {
	return New("questionSubmission", spec.C.DomainTags.QuestionSubmission,
		Bytes32("examId", examID),
		Bytes("challenge", challenge),
		Bytes32("questionHash", questionHash))
}

// QuestionReceipt is the TEE's signed receipt for one question.
func QuestionReceipt(examID [32]byte, passkeyPublicKey []byte, questionHash [32]byte) (Message, error) {
	if err := checkKeys("questionReceipt", passkeyPublicKey); err != nil {
		return Message{}, err
	}
	return New("questionReceipt", spec.C.DomainTags.QuestionReceipt,
		Bytes32("examId", examID),
		Bytes("passkeyPublicKey", passkeyPublicKey),
		Bytes32("questionHash", questionHash))
}

// BuildFields are the fields of the Build. Named fields keep its six 32-byte
// values from being swapped at a call site.
type BuildFields struct {
	ExamID              [32]byte
	ApprovedListHash    [32]byte // The Sum of the ApprovedList message.
	PaperHash           [32]byte // Plain SHA-256 of the encrypted paper file.
	StorageManifestHash [32]byte
	SaltedPaperHash     [32]byte // The Sum of the SaltedPaper message.
	Selected            uint32
	BankSize            uint32
	CriteriaHash        [32]byte
}

// Build commits to the approved list, the stored files and the selection.
func Build(f BuildFields) Message {
	return must(New("build", spec.C.DomainTags.Build,
		Bytes32("examId", f.ExamID),
		Bytes32("approvedListHash", f.ApprovedListHash),
		Bytes32("paperHash", f.PaperHash),
		Bytes32("storageManifestHash", f.StorageManifestHash),
		Bytes32("saltedPaperHash", f.SaltedPaperHash),
		Uint32("selected", f.Selected),
		Uint32("bankSize", f.BankSize),
		Bytes32("criteriaHash", f.CriteriaHash)))
}

// SaltedPaper is the preimage of build.saltedPaperHash. The plaintext is never
// hashed unsalted, because that would let people test guesses at it.
func SaltedPaper(seed [32]byte, paper []byte) (Message, error) {
	return New("saltedPaperHash", spec.C.DomainTags.PaperHash,
		Bytes32("seed", seed),
		Bytes("paper", paper))
}

// ShareHash is the published hash of one key holder's share.
func ShareHash(share []byte) (Message, error) {
	return New("shareHash", spec.C.DomainTags.ShareHash, Bytes("share", share))
}

// ShareRelease is the message a holder's passkey signs when releasing a share.
// It doesn't cover the share hash: one WebAuthn request gives both the
// signature and the PRF output, so the share isn't decrypted when it signs.
func ShareRelease(examID [32]byte, challenge []byte) (Message, error) {
	return New("shareRelease", spec.C.DomainTags.ShareRelease,
		Bytes32("examId", examID),
		Bytes("challenge", challenge))
}

// ReleaseLog commits to the signed release log.
func ReleaseLog(examID, entriesHash [32]byte) Message {
	return must(New("releaseLog", spec.C.DomainTags.ReleaseLog,
		Bytes32("examId", examID),
		Bytes32("entriesHash", entriesHash)))
}

// must is for messages with only fixed-width fields, which New can't fail to
// encode.
func must(m Message, err error) Message {
	if err != nil {
		panic(err)
	}
	return m
}

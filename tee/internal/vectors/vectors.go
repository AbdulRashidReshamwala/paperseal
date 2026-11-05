// Package vectors builds testdata/vectors.json, the fixed inputs and expected
// bytes that every other language checks itself against.
//
// Run go test ./internal/vectors -update after a deliberate format change.
package vectors

import (
	"crypto/ecdh"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"paperseal/tee/internal/approvedlist"
	"paperseal/tee/internal/attestation"
	"paperseal/tee/internal/criteria"
	"paperseal/tee/internal/hashing"
)

// File is the JSON document, one vector per message. Hex values use the 0x
// prefix from spec/api.md, except nonce, which the spec defines as bare hex.
type File struct {
	Version          int            `json:"version"`
	Note             string         `json:"note"`
	Hash             []HashVector   `json:"hash"`
	Criteria         CriteriaVector `json:"criteria"`
	ApprovedList     ListVector     `json:"approvedList"`
	AttestationNonce NonceVector    `json:"attestationNonce"`
}

// FieldValue is one input field. Type is its ABI type. Value is hex for bytes
// and bytes32, and decimal for uint32.
type FieldValue struct {
	Name  string `json:"name"`
	Type  string `json:"type"`
	Value string `json:"value"`
}

// HashVector is one message.
type HashVector struct {
	Message  string       `json:"message"`
	Tag      string       `json:"tag"`
	Fields   []FieldValue `json:"fields"`
	Preimage string       `json:"preimage"`
	Hash     string       `json:"hash"`
}

// CriteriaVector is the criteria sample. Hash is its criteria message hash, and
// Selected is the sum of its topics' questions.
type CriteriaVector struct {
	Decoded  criteria.Criteria `json:"decoded"`
	Encoded  string            `json:"encoded"`
	Hash     string            `json:"hash"`
	Selected uint32            `json:"selected"`
}

// ListVector is the entries sample. It has one entry per role, so it pins the
// encoding of each, but the TEE rejects it for its key-holder counts. Hash is
// the approvedList hash of ExamID and Entries.
type ListVector struct {
	ExamID  string      `json:"examId"`
	Decoded []ListEntry `json:"decoded"`
	Entries string      `json:"entries"`
	Hash    string      `json:"hash"`
}

// ListEntry is one entry before encoding.
type ListEntry struct {
	Role             uint8  `json:"role"`
	PasskeyPublicKey string `json:"passkeyPublicKey"`
	DerivedPublicKey string `json:"derivedPublicKey"`
	Owner            string `json:"owner"`
}

// NonceVector is one eat_nonce.
type NonceVector struct {
	InstancePublicKey string `json:"instancePublicKey"`
	ExamID            string `json:"examId"`
	Preimage          string `json:"preimage"`
	Nonce             string `json:"nonce"`
}

func x(b []byte) string { return "0x" + hex.EncodeToString(b) }

func fill(b byte) (out [32]byte) {
	for i := range out {
		out[i] = b
	}
	return out
}

// pubKey returns scalar times the P-256 base point: a valid, fixed key.
func pubKey(scalar byte) []byte {
	s := make([]byte, 32)
	s[31] = scalar
	priv, err := ecdh.P256().NewPrivateKey(s)
	if err != nil {
		panic(err)
	}
	return priv.PublicKey().Bytes()
}

func fieldText(v any) string {
	switch v := v.(type) {
	case [32]byte:
		return x(v[:])
	case []byte:
		return x(v)
	case uint32:
		return fmt.Sprint(v)
	}
	panic(fmt.Sprintf("vectors: no text form for %T", v))
}

func hashVector(m hashing.Message) HashVector {
	fields := make([]FieldValue, len(m.Fields))
	for i, f := range m.Fields {
		fields[i] = FieldValue{f.Name, f.Type.String(), fieldText(f.Value)}
	}
	sum := m.Sum()
	return HashVector{m.Name, m.Tag, fields, x(m.Encode()), x(sum[:])}
}

// SampleCriteria is a valid set of criteria for a 20-question paper.
func SampleCriteria() criteria.Criteria {
	return criteria.Criteria{
		MaxSetterPercent: 10,
		MinBankMultiple:  3,
		Topics:           []criteria.Topic{{Name: "algebra", Questions: 12}, {Name: "geometry", Questions: 8}},
	}
}

// SamplePerRole has one entry per role.
func SamplePerRole() []approvedlist.Entry {
	return []approvedlist.Entry{
		{Role: approvedlist.RoleSetter, PasskeyPublicKey: pubKey(1), Owner: "setter-01"},
		{Role: approvedlist.RoleNeutral, PasskeyPublicKey: pubKey(3), DerivedPublicKey: pubKey(4), Owner: "neutral-01"},
		{Role: approvedlist.RoleCentreHolder, PasskeyPublicKey: pubKey(5), DerivedPublicKey: pubKey(6), Owner: "centre-01"},
		{Role: approvedlist.RoleCentre, PasskeyPublicKey: pubKey(7), DerivedPublicKey: pubKey(8), Owner: "centre-02"},
	}
}

// Build returns the document.
func Build() (File, error) {
	examID := fill(0x11)
	first := fill(0x33)
	second := fill(0x44)
	challenge := fill(0x55)
	third := fill(0x66)

	sampleCriteria := SampleCriteria()
	encodedCriteria, err := criteria.Encode(sampleCriteria)
	if err != nil {
		return File{}, err
	}
	criteriaMessage, err := hashing.Criteria(encodedCriteria)
	if err != nil {
		return File{}, err
	}
	criteriaHash := criteriaMessage.Sum()
	selected, err := sampleCriteria.Selected()
	if err != nil {
		return File{}, err
	}

	sample := SamplePerRole()
	entries, err := approvedlist.Encode(sample)
	if err != nil {
		return File{}, err
	}
	list, err := hashing.ApprovedList(examID, entries)
	if err != nil {
		return File{}, err
	}
	listHash := list.Sum()

	var msgs []hashing.Message
	var failed error
	add := func(m hashing.Message, err error) {
		failed = errors.Join(failed, err)
		msgs = append(msgs, m)
	}
	add(hashing.Registration(pubKey(1), []byte("centre-01"), challenge[:]))
	add(criteriaMessage, nil)
	add(list, nil)
	add(hashing.QuestionSubmission(examID, challenge[:], first))
	add(hashing.QuestionReceipt(examID, pubKey(1), first))
	add(hashing.Build(hashing.BuildFields{
		ExamID:              examID,
		ApprovedListHash:    listHash,
		PaperHash:           first,
		StorageManifestHash: second,
		SaltedPaperHash:     third,
		Selected:            selected,
		BankSize:            240,
		CriteriaHash:        criteriaHash,
	}), nil)
	add(hashing.SaltedPaper(first, []byte(`{"questions":[]}`)))
	add(hashing.ShareHash([]byte("share-bytes")))
	add(hashing.ShareRelease(examID, challenge[:]))
	add(hashing.ReleaseLog(examID, first), nil)
	if failed != nil {
		return File{}, failed
	}

	f := File{
		Version: 1,
		Note: "Generated by tee/internal/vectors from fixed inputs. Public keys are 1G, 2G, ... on P-256. " +
			"Each message is SHA-256(abi.encode(string tag, field, ...)). " +
			"The approvedList sample pins the encoding only: its key-holder counts are wrong, so the TEE rejects it.",
		Criteria:     CriteriaVector{sampleCriteria, x(encodedCriteria), x(criteriaHash[:]), selected},
		ApprovedList: ListVector{ExamID: x(examID[:]), Entries: x(entries), Hash: x(listHash[:])},
	}
	for _, e := range sample {
		f.ApprovedList.Decoded = append(f.ApprovedList.Decoded,
			ListEntry{uint8(e.Role), x(e.PasskeyPublicKey), x(e.DerivedPublicKey), e.Owner})
	}
	for _, m := range msgs {
		f.Hash = append(f.Hash, hashVector(m))
	}

	key := pubKey(1)
	m, err := hashing.AttestationNonce(key, examID)
	if err != nil {
		return File{}, err
	}
	nonce, err := attestation.Nonce(key, examID)
	if err != nil {
		return File{}, err
	}
	f.AttestationNonce = NonceVector{x(key), x(examID[:]), x(m.Encode()), nonce}
	return f, nil
}

// Marshal renders the document exactly as it is stored.
func Marshal(f File) ([]byte, error) {
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

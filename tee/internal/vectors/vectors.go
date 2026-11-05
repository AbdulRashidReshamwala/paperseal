// Package vectors builds testdata/vectors.json, the fixed inputs and expected
// bytes that every other language checks itself against.
//
// Run go test ./internal/vectors -update after a deliberate format change.
package vectors

import (
	"crypto/ecdh"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"paperseal/tee/internal/approvedlist"
	"paperseal/tee/internal/attestation"
	"paperseal/tee/internal/criteria"
	"paperseal/tee/internal/encryption"
	"paperseal/tee/internal/hashing"
	"paperseal/tee/internal/release"
	"paperseal/tee/internal/spec"
	"paperseal/tee/internal/storage"
	"paperseal/tee/internal/webauthn"
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
	HPKE             []HPKEVector   `json:"hpke"`
	AES              AESVector      `json:"aes"`
	Padding          []PadVector    `json:"padding"`
	Release          ReleaseVector  `json:"release"`
	ReleaseEntries   EntriesVector  `json:"releaseEntries"`
	Manifest         ManifestVector `json:"manifest"`
	Limits           LimitsVector   `json:"limits"`
}

// LimitsVector holds inputs every reader must reject without decoding them, per
// "Size Limits" in spec/api.md. Each input is Prefix followed by zero bytes up
// to Length bytes in all, which keeps the file small: a shared-offset attack is
// a few hundred bytes of offsets and then one large zero-filled value.
type LimitsVector struct {
	Reject []RejectVector `json:"reject"`
}

// RejectVector is one input that must be refused. Kind is "entries" or
// "criteria". Reason is "overCap" for a value longer than its byte cap, or
// "sharedOffsets" for array offsets that don't start after the head, increase
// strictly and leave each element ending before the next.
type RejectVector struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	Reason string `json:"reason"`
	Prefix string `json:"prefix"`
	Length int    `json:"length"`
}

// Bytes returns the input the vector describes.
func (r RejectVector) Bytes() ([]byte, error) {
	prefix, err := hex.DecodeString(strings.TrimPrefix(r.Prefix, "0x"))
	if err != nil {
		return nil, err
	}
	if r.Length < len(prefix) {
		return nil, fmt.Errorf("vectors: %s: length %d is shorter than its prefix", r.Name, r.Length)
	}
	return append(prefix, make([]byte, r.Length-len(prefix))...), nil
}

func word(n uint64) []byte {
	return binary.BigEndian.AppendUint64(make([]byte, 24), n)
}

// sharedEntries is a list of n entries whose offsets all point at one entry,
// whose owner is zeros up to length bytes in all.
func sharedEntries(n, length int) RejectVector {
	b := append(word(0x20), word(uint64(n))...)
	for range n {
		b = append(b, word(uint64(32*n))...)
	}
	// One entry: role 1, then offsets of passkey, derived and owner. The
	// passkey and derived values are empty and the owner is the large value.
	b = append(b, word(1)...)
	b = append(b, word(0x80)...)
	b = append(b, word(0xa0)...)
	b = append(b, word(0xc0)...)
	b = append(b, word(0)...)
	b = append(b, word(0)...)
	b = append(b, word(uint64(length-len(b)-32))...)
	return RejectVector{"entries share one large entry", "entries", "sharedOffsets", x(b), length}
}

// sharedTopics is the same attack on criteria.topics.
func sharedTopics(n, length int) RejectVector {
	b := append(word(0x20), word(10)...)
	b = append(b, word(3)...)
	b = append(b, word(0x60)...)
	b = append(b, word(uint64(n))...)
	for range n {
		b = append(b, word(uint64(32*n))...)
	}
	b = append(b, word(0x40)...)
	b = append(b, word(1)...)
	b = append(b, word(uint64(length-len(b)-32))...)
	return RejectVector{"topics share one large topic", "criteria", "sharedOffsets", x(b), length}
}

func limitsVector() LimitsVector {
	l := spec.C.Limits
	validList, err := approvedlist.Encode(SamplePerRole())
	if err != nil {
		panic(err)
	}
	validCriteria, err := criteria.Encode(SampleCriteria())
	if err != nil {
		panic(err)
	}
	return LimitsVector{Reject: []RejectVector{
		{"entries one byte over the cap", "entries", "overCap", x(validList), l.EntriesBytes + 1},
		{"criteria one byte over the cap", "criteria", "overCap", x(validCriteria), l.CriteriaBytes + 1},
		sharedEntries(100, l.EntriesBytes-1024),
		sharedTopics(20, l.CriteriaBytes-1024),
	}}
}

// HPKEVector is one message sealed in Go. A reader derives the recipient key
// from RecipientIKM with RFC 9180 DeriveKeyPair (the WebAuthn PRF output plays
// this role in the apps), checks it gives RecipientPublicKey, and opens Sealed
// with the purpose's info and ExamID as aad to get Plaintext.
type HPKEVector struct {
	Purpose            string `json:"purpose"`
	Info               string `json:"info"`
	ExamID             string `json:"examId"`
	RecipientIKM       string `json:"recipientIkm"`
	RecipientPublicKey string `json:"recipientPublicKey"`
	Plaintext          string `json:"plaintext"`
	Sealed             string `json:"sealed"`
}

// AESVector is AES-256-GCM framed as nonce || ciphertext || tag, with the
// examId as aad.
type AESVector struct {
	Key       string `json:"key"`
	ExamID    string `json:"examId"`
	Plaintext string `json:"plaintext"`
	Sealed    string `json:"sealed"`
}

// PadVector is Pad(Data, Size) = Padded, or a rejection when Padded is empty.
// Unpad(Padded, Size) gives Data back.
type PadVector struct {
	Data   string `json:"data"`
	Size   int    `json:"size"`
	Padded string `json:"padded"`
}

// ReleaseVector is the `release` plaintext, abi.encode(bytes share, bytes
// signature, bytes authenticatorData, bytes clientDataJSON).
type ReleaseVector struct {
	Share             string `json:"share"`
	Signature         string `json:"signature"`
	AuthenticatorData string `json:"authenticatorData"`
	ClientDataJSON    string `json:"clientDataJSON"`
	Encoded           string `json:"encoded"`
}

// EntriesVector is entriesHash: SHA-256 of abi.encode(ReleaseEntry[]).
type EntriesVector struct {
	Entries     []EntryJSON `json:"entries"`
	Preimage    string      `json:"preimage"`
	EntriesHash string      `json:"entriesHash"`
}

// EntryJSON is one ReleaseEntry. Round is a decimal string.
type EntryJSON struct {
	PasskeyPublicKey string `json:"passkeyPublicKey"`
	ShareHash        string `json:"shareHash"`
	Round            string `json:"round"`
}

// ManifestVector is manifest.json, whose plain SHA-256 is storageManifestHash.
// Manifest is the exact text of the file.
type ManifestVector struct {
	Manifest string `json:"manifest"`
	Hash     string `json:"storageManifestHash"`
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
	case string:
		return v
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

// sampleSetterCommitment is the commitment of the sample setter, "setter-01".
func sampleSetterCommitment() (hashing.Message, error) {
	return hashing.SetterCommitment(fill(0x11), "setter-01", fill(0x77))
}

// SamplePerRole has one entry per role. The setter's owner is its commitment.
func SamplePerRole() []approvedlist.Entry {
	commitment, err := sampleSetterCommitment()
	if err != nil {
		panic(err)
	}
	sum := commitment.Sum()
	return []approvedlist.Entry{
		{Role: approvedlist.RoleSetter, PasskeyPublicKey: pubKey(1), Owner: x(sum[:])},
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
	add(hashing.InstanceKey(examID, pubKey(2)))
	add(sampleSetterCommitment())
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
			"HPKE and AES vectors are sealed in Go with repeatable randomness, to be opened in TypeScript. " +
			"limits.reject inputs are Prefix then zero bytes up to Length, and every reader must refuse them before decoding. " +
			"The approvedList sample pins the encoding only: its key-holder counts are wrong, so the TEE rejects it.",
		Criteria:     CriteriaVector{sampleCriteria, x(encodedCriteria), x(criteriaHash[:]), selected},
		Limits:       limitsVector(),
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
	if err := addEncryption(&f, examID); err != nil {
		return File{}, err
	}
	if err := addRelease(&f); err != nil {
		return File{}, err
	}
	return f, nil
}

// stream is a repeatable byte stream, SHA-256 in counter mode. It stands in
// for crypto/rand so the sealed vectors are the same every run. It is for test
// vectors only.
type stream struct {
	seed string
	n    uint64
	buf  []byte
}

func (s *stream) Read(p []byte) (int, error) {
	for len(s.buf) < len(p) {
		h := sha256.Sum256([]byte(fmt.Sprintf("%s/%d", s.seed, s.n)))
		s.n++
		s.buf = append(s.buf, h[:]...)
	}
	copy(p, s.buf)
	s.buf = s.buf[len(p):]
	return len(p), nil
}

func addEncryption(f *File, examID [32]byte) error {
	info := spec.C.Crypto.HPKE.Info
	purposes := []struct {
		name string
		p    encryption.Purpose
		info string
		pt   string
	}{
		{"question", encryption.PurposeQuestion, info.Question, "padded question bytes"},
		{"share", encryption.PurposeShare, info.Share, "a shamir share"},
		{"release", encryption.PurposeRelease, info.Release, "release plaintext bytes"},
		{"keyPriv", encryption.PurposeKeyPriv, info.KeyPriv, "thirty-two byte K_priv value...."},
	}
	for i, pu := range purposes {
		ikm := fill(0xa0 + byte(i))
		key, err := encryption.DeriveKey(ikm[:])
		if err != nil {
			return err
		}
		sealed, err := encryption.SealFrom(&stream{seed: "hpke/" + pu.name}, pu.p, key.PublicKey(), examID, []byte(pu.pt))
		if err != nil {
			return err
		}
		f.HPKE = append(f.HPKE, HPKEVector{
			Purpose: pu.name, Info: pu.info, ExamID: x(examID[:]), RecipientIKM: x(ikm[:]),
			RecipientPublicKey: x(key.PublicKey()), Plaintext: x([]byte(pu.pt)), Sealed: x(sealed),
		})
	}

	aesKey := fill(0xb1)
	pt := []byte("the paper bytes")
	sealed, err := encryption.SealAESFrom(&stream{seed: "aes"}, aesKey[:], examID, pt)
	if err != nil {
		return err
	}
	f.AES = AESVector{x(aesKey[:]), x(examID[:]), x(pt), x(sealed)}

	for _, c := range []struct {
		data string
		size int
	}{{"", 8}, {"abc", 16}, {"twelve bytes", 16}, {"0123456789abcdef", 20}} {
		p, err := encryption.Pad([]byte(c.data), c.size)
		if err != nil {
			return err
		}
		f.Padding = append(f.Padding, PadVector{x([]byte(c.data)), c.size, x(p)})
	}
	// Data that doesn't fit has no padded form.
	f.Padding = append(f.Padding, PadVector{x([]byte("thirteen byte")), 16, ""})
	return nil
}

func addRelease(f *File) error {
	share := []byte("share-bytes-for-release-vector")
	a := webauthn.Assertion{
		Signature:         []byte{0x30, 0x44, 0x02, 0x20, 0x01, 0x02, 0x03},
		AuthenticatorData: append(bytes32(0x77), 0x05, 0, 0, 0, 1),
		ClientDataJSON:    []byte(`{"type":"webauthn.get","challenge":"AAAA"}`),
	}
	enc, err := release.EncodeRelease(share, a)
	if err != nil {
		return err
	}
	f.Release = ReleaseVector{x(share), x(a.Signature), x(a.AuthenticatorData), x(a.ClientDataJSON), x(enc)}

	entries := []release.Entry{
		{PasskeyPublicKey: pubKey(3), ShareHash: fill(0x31), Round: 35731612},
		{PasskeyPublicKey: pubKey(5), ShareHash: fill(0x32), Round: 35731613},
	}
	h, err := release.EntriesHash(entries)
	if err != nil {
		return err
	}
	pre, err := release.EntriesPreimage(entries)
	if err != nil {
		return err
	}
	ev := EntriesVector{Preimage: x(pre), EntriesHash: x(h[:])}
	for _, e := range entries {
		ev.Entries = append(ev.Entries, EntryJSON{x(e.PasskeyPublicKey), x(e.ShareHash[:]), fmt.Sprint(e.Round)})
	}
	f.ReleaseEntries = ev

	examID := fill(0x11)
	derived := pubKey(4)
	m := storage.NewManifest(examID, []storage.ManifestFile{
		{Name: "token.jwt", SHA256: x(bytes32(0x23))},
		{Name: "paper.bin", SHA256: x(bytes32(0x21))},
		{Name: "key-pub.tlock", SHA256: x(bytes32(0x22))},
		{Name: "shares/" + x(derived) + ".bin", SHA256: x(bytes32(0x24)), Recipient: x(derived), ShareHash: x(bytes32(0x31))},
	})
	b, err := m.Marshal()
	if err != nil {
		return err
	}
	sum := storage.Hash(b)
	f.Manifest = ManifestVector{string(b), x(sum[:])}
	return nil
}

func bytes32(b byte) []byte { v := fill(b); return v[:] }

// Marshal renders the document exactly as it is stored.
func Marshal(f File) ([]byte, error) {
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

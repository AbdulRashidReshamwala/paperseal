package hashing

import (
	"bytes"
	"crypto/ecdh"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"strings"
	"testing"
)

func fill(b byte) (out [32]byte) {
	for i := range out {
		out[i] = b
	}
	return out
}

// key returns scalar times the P-256 base point.
func key(t *testing.T, scalar byte) []byte {
	t.Helper()
	s := make([]byte, 32)
	s[31] = scalar
	priv, err := ecdh.P256().NewPrivateKey(s)
	if err != nil {
		t.Fatal(err)
	}
	return priv.PublicKey().Bytes()
}

// word is a 32-byte big-endian integer.
func word(n uint64) []byte {
	return binary.BigEndian.AppendUint64(make([]byte, 24), n)
}

// A value is one argument to abiEncode. A fixed value goes in the head. A
// dynamic one goes in the tail, with a length word and zero padding.
type value struct {
	fixed   []byte
	dynamic []byte
}

func b32(b byte) value    { return value{fixed: bytes.Repeat([]byte{b}, 32)} }
func u32(n uint32) value  { return value{fixed: word(uint64(n))} }
func dyn(b []byte) value  { return value{dynamic: b} }
func text(s string) value { return dyn([]byte(s)) }

// abiEncode is a test-only copy of the ABI rules, so the layouts below are
// checked against something other than the library under test.
func abiEncode(values ...value) []byte {
	var head, tail []byte
	for _, v := range values {
		if v.fixed != nil {
			head = append(head, v.fixed...)
			continue
		}
		head = append(head, word(uint64(32*len(values)+len(tail)))...)
		tail = append(tail, word(uint64(len(v.dynamic)))...)
		tail = append(tail, v.dynamic...)
		if pad := len(v.dynamic) % 32; pad != 0 {
			tail = append(tail, make([]byte, 32-pad)...)
		}
	}
	return append(head, tail...)
}

// A fully written-out encoding, independent of even the helper above.
func TestShareHashBytes(t *testing.T) {
	m, err := ShareHash([]byte{0xaa})
	if err != nil {
		t.Fatal(err)
	}
	tag := hex.EncodeToString([]byte("paperseal/v1/share-hash"))
	want := strings.Join([]string{
		strings.Repeat("0", 62) + "40", // offset of the tag
		strings.Repeat("0", 62) + "80", // offset of the share
		strings.Repeat("0", 62) + "17", // tag length, 23
		tag + strings.Repeat("0", 64-len(tag)),
		strings.Repeat("0", 62) + "01", // share length
		"aa" + strings.Repeat("0", 62),
	}, "")
	if got := hex.EncodeToString(m.Encode()); got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
	if got := m.Sum(); got != sha256.Sum256(m.Encode()) {
		t.Fatalf("Sum is not SHA-256 of Encode: %x", got)
	}
}

// Dynamic fields must stop bytes shifting between adjacent fields.
func TestVariableFieldsDoNotShift(t *testing.T) {
	k := key(t, 1)
	a, err := Registration(k, []byte("ab"), []byte("c"), fill(1))
	if err != nil {
		t.Fatal(err)
	}
	b, err := Registration(k, []byte("a"), []byte("bc"), fill(1))
	if err != nil {
		t.Fatal(err)
	}
	if a.Sum() == b.Sum() {
		t.Fatal("different field splits gave the same hash")
	}
}

func TestSaltedPaperUsesPaperHashTag(t *testing.T) {
	m, err := SaltedPaper(fill(0x22), []byte("paper"))
	if err != nil {
		t.Fatal(err)
	}
	if m.Tag != "paperseal/v1/paper-hash" {
		t.Fatalf("tag %q", m.Tag)
	}
}

func TestCheckPublicKey(t *testing.T) {
	good := key(t, 1)
	if err := CheckPublicKey(good); err != nil {
		t.Fatal(err)
	}
	compressed := append([]byte{0x02}, good[1:33]...)
	wrongPrefix := bytes.Clone(good)
	wrongPrefix[0] = 0x05
	offCurve := bytes.Clone(good)
	offCurve[64] ^= 1
	for name, k := range map[string][]byte{
		"empty": nil, "compressed": compressed, "wrong prefix": wrongPrefix, "off curve": offCurve,
	} {
		if err := CheckPublicKey(k); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := AttestationNonce(compressed, fill(1)); err == nil {
		t.Error("AttestationNonce accepted a compressed key")
	}
	if _, err := Registration(compressed, nil, nil, fill(1)); err == nil {
		t.Error("Registration accepted a compressed key")
	}
	if _, err := QuestionReceipt(fill(1), compressed, fill(2)); err == nil {
		t.Error("QuestionReceipt accepted a compressed key")
	}
	if _, err := QuestionReceipt(fill(1), nil, fill(2)); err == nil {
		t.Error("QuestionReceipt accepted an empty key")
	}
}

// Every message has its own tag, so the same fields never collide across
// message types.
func TestSameFieldsDifferentTags(t *testing.T) {
	a, err := ShareRelease(fill(1), []byte("c"))
	if err != nil {
		t.Fatal(err)
	}
	b, err := ApprovedList(fill(1), []byte("c"))
	if err != nil {
		t.Fatal(err)
	}
	if a.Sum() == b.Sum() {
		t.Fatal("two message types with the same fields hashed alike")
	}
}

// Each layout is written out from the Signed Messages table in spec/api.md, so
// a field moved in the code can't pass by matching itself.
func TestSignedMessageLayouts(t *testing.T) {
	k := key(t, 1)
	msg := func(m Message, err error) Message {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	cases := []struct {
		name string
		m    Message
		want []value
	}{
		{"attestationNonce", msg(AttestationNonce(k, fill(1))),
			[]value{text("paperseal/v1/attestation-nonce"), dyn(k), b32(1)}},
		{"registration", msg(Registration(k, []byte{0xaa}, []byte{0xbb, 0xcc}, fill(0xdd))),
			[]value{text("paperseal/v1/registration"), dyn(k), dyn([]byte{0xaa}), dyn([]byte{0xbb, 0xcc}), b32(0xdd)}},
		{"setter registration", msg(Registration(nil, []byte{0xaa}, []byte{0xbb}, fill(0xdd))),
			[]value{text("paperseal/v1/registration"), dyn([]byte{}), dyn([]byte{0xaa}), dyn([]byte{0xbb}), b32(0xdd)}},
		{"setterOwner", msg(SetterOwner(k)),
			[]value{text("paperseal/v1/setter-owner"), dyn(k)}},
		{"criteria", msg(Criteria([]byte{0xaa})),
			[]value{text("paperseal/v1/criteria"), dyn([]byte{0xaa})}},
		{"approvedList", msg(ApprovedList(fill(1), []byte{0xaa, 0xbb})),
			[]value{text("paperseal/v1/approved-list"), b32(1), dyn([]byte{0xaa, 0xbb})}},
		{"questionSubmission", msg(QuestionSubmission(fill(1), []byte{0xaa}, fill(2))),
			[]value{text("paperseal/v1/question-submission"), b32(1), dyn([]byte{0xaa}), b32(2)}},
		{"questionReceipt", msg(QuestionReceipt(fill(1), k, fill(2))),
			[]value{text("paperseal/v1/question-receipt"), b32(1), dyn(k), b32(2)}},
		{"build", Build(BuildFields{
			ExamID: fill(1), ApprovedListHash: fill(2), PaperHash: fill(3), StorageManifestHash: fill(4),
			SaltedPaperHash: fill(5), Selected: 20, BankSize: 240, CriteriaHash: fill(6),
		}), []value{text("paperseal/v1/build"), b32(1), b32(2), b32(3), b32(4), b32(5), u32(20), u32(240), b32(6)}},
		{"saltedPaperHash", msg(SaltedPaper(fill(1), []byte{0xaa})),
			[]value{text("paperseal/v1/paper-hash"), b32(1), dyn([]byte{0xaa})}},
		{"shareHash", msg(ShareHash([]byte{0xaa})),
			[]value{text("paperseal/v1/share-hash"), dyn([]byte{0xaa})}},
		{"shareRelease", msg(ShareRelease(fill(1), []byte{0xaa})),
			[]value{text("paperseal/v1/share-release"), b32(1), dyn([]byte{0xaa})}},
		{"releaseLog", ReleaseLog(fill(1), fill(2)),
			[]value{text("paperseal/v1/release-log"), b32(1), b32(2)}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got, want := c.m.Encode(), abiEncode(c.want...); !bytes.Equal(got, want) {
				t.Fatalf("got  %x\nwant %x", got, want)
			}
		})
	}
}

package encryption

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"testing"

	"paperseal/tee/internal/spec"
)

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestSuiteMatchesConstants(t *testing.T) {
	h := spec.C.Crypto.HPKE
	if h.KEM != "DHKEM(P-256, HKDF-SHA256)" || h.KDF != "HKDF-SHA256" || h.AEAD != "AES-256-GCM" {
		t.Fatalf("constants name another suite: %+v", h)
	}
	for name, info := range map[string]string{
		"question": h.Info.Question, "share": h.Info.Share, "release": h.Info.Release, "keyPriv": h.Info.KeyPriv,
	} {
		if !strings.HasPrefix(info, "paperseal/v1/hpke-") {
			t.Errorf("%s info %q", name, info)
		}
	}
}

// RFC 9180 test vector for DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and
// AES-256-GCM in base mode, with the first encryption. It pins the key
// derivation, the encapsulation and the framing against the RFC, not only
// against this code.
func TestRFC9180Vector(t *testing.T) {
	ikmR := unhex(t, "a0ce15d49e28bd47a18a97e147582d814b08cbe00109fed5ec27d1b4e9f6f5e3")
	ikmE := unhex(t, "a90d3417c3da9cb6c6ae19b4b5dd6cc9529a4cc24efb7ae0ace1f31887a8cd6c")
	info := unhex(t, "4f6465206f6e2061204772656369616e2055726e")
	pkRm := unhex(t, "04abc7e49a4c6b3566d77d0304addc6ed0e98512ffccf505e6a8e3eb25c685136f853148544876de76c0f2ef99cdc3a05ccf5ded7860c7c021238f9e2073d2356c")
	enc := unhex(t, "04c06b4f6bebc7bb495cb797ab753f911aff80aefb86fd8b6fcc35525f3ab5f03e0b21bd31a86c6048af3cb2d98e0d3bf01da5cc4c39ff5370d331a4f1f7d5a4e0")
	aad := unhex(t, "436f756e742d30")
	ct := unhex(t, "58c61a45059d0c5704560e9d88b564a8b63f1364b8d1fcb3c4c6ddc1d291742465e902cd216f8908da49f8f96f")
	pt := unhex(t, "4265617574792069732074727574682c20747275746820626561757479")

	key, err := DeriveKey(ikmR)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(key.PublicKey(), pkRm) {
		t.Fatal("DeriveKeyPair does not match RFC 9180")
	}
	// The package fixes the info and takes an examId aad, so run the suite
	// directly with the RFC's values.
	pk, _ := kemID.Scheme().UnmarshalBinaryPublicKey(pkRm)
	sender, err := suite.NewSender(pk, info)
	if err != nil {
		t.Fatal(err)
	}
	gotEnc, sealer, err := sender.Setup(bytes.NewReader(ikmE))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotEnc, enc) {
		t.Fatal("enc does not match RFC 9180")
	}
	gotCT, err := sealer.Seal(pt, aad)
	if err != nil || !bytes.Equal(gotCT, ct) {
		t.Fatalf("ciphertext does not match RFC 9180: %v", err)
	}
	receiver, err := suite.NewReceiver(key.k, info)
	if err != nil {
		t.Fatal(err)
	}
	opener, err := receiver.Setup(enc)
	if err != nil {
		t.Fatal(err)
	}
	got, err := opener.Open(ct, aad)
	if err != nil || !bytes.Equal(got, pt) {
		t.Fatalf("open: %v", err)
	}
}

func TestSealOpenRoundTripAndBinding(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	var exam, other [32]byte
	exam[0], other[0] = 1, 2
	framed, err := Seal(PurposeShare, key.PublicKey(), exam, []byte("hello"))
	if err != nil {
		t.Fatal(err)
	}
	if len(framed) != 65+5+16 {
		t.Fatalf("framed length %d", len(framed))
	}
	got, err := key.Open(PurposeShare, exam, framed)
	if err != nil || string(got) != "hello" {
		t.Fatalf("open: %q %v", got, err)
	}
	if _, err := key.Open(PurposeRelease, exam, framed); !errors.Is(err, ErrOpen) {
		t.Error("opened under another purpose")
	}
	if _, err := key.Open(PurposeShare, other, framed); !errors.Is(err, ErrOpen) {
		t.Error("opened under another exam")
	}
	framed[len(framed)-1] ^= 1
	if _, err := key.Open(PurposeShare, exam, framed); !errors.Is(err, ErrOpen) {
		t.Error("opened a tampered message")
	}
	if _, err := key.Open(PurposeShare, exam, framed[:10]); !errors.Is(err, ErrOpen) {
		t.Error("opened a short message")
	}
	if _, err := Seal(PurposeShare, []byte{1, 2, 3}, exam, nil); err == nil {
		t.Error("sealed to a bad key")
	}
}

// A question's aad is examId || passkeyPublicKey, so a ciphertext only opens
// for the setter who sent it.
func TestQuestionAADBindsTheSetter(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	var exam, other [32]byte
	exam[0], other[0] = 1, 2
	asha, ben := testKey(t, 1), testKey(t, 2)
	framed, err := SealQuestion(key.PublicKey(), exam, asha, []byte("q"))
	if err != nil {
		t.Fatal(err)
	}
	if got, err := key.OpenQuestion(exam, asha, framed); err != nil || string(got) != "q" {
		t.Fatalf("open: %q %v", got, err)
	}
	if _, err := key.OpenQuestion(exam, ben, framed); !errors.Is(err, ErrOpen) {
		t.Error("another setter's passkey opened it")
	}
	if _, err := key.OpenQuestion(other, asha, framed); !errors.Is(err, ErrOpen) {
		t.Error("opened under another exam")
	}
	// The aad is not examId alone, which is what the question used to carry.
	if _, err := key.openAAD(PurposeQuestion, exam[:], framed); !errors.Is(err, ErrOpen) {
		t.Error("opened with examId as the aad")
	}
	if want := append(exam[:], asha...); !bytes.Equal(QuestionAAD(exam, asha), want) {
		t.Error("aad is not examId || passkeyPublicKey")
	}
	// The generic calls refuse a question rather than use the wrong aad.
	if _, err := Seal(PurposeQuestion, key.PublicKey(), exam, nil); !errors.Is(err, ErrQuestionAAD) {
		t.Errorf("Seal(question): %v", err)
	}
	if _, err := key.Open(PurposeQuestion, exam, framed); !errors.Is(err, ErrQuestionAAD) {
		t.Errorf("Open(question): %v", err)
	}
	if _, err := SealQuestion(key.PublicKey(), exam, []byte{1}, nil); err == nil {
		t.Error("sealed with a bad passkey")
	}
}

func testKey(t *testing.T, n byte) []byte {
	t.Helper()
	k, err := DeriveKey(bytes.Repeat([]byte{n}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return k.PublicKey()
}

func TestAESRoundTrip(t *testing.T) {
	key := make([]byte, 32)
	rand.Read(key)
	var exam, other [32]byte
	other[0] = 9
	framed, err := SealAES(key, exam, []byte("paper"))
	if err != nil {
		t.Fatal(err)
	}
	if len(framed) != 12+5+16 {
		t.Fatalf("framed length %d", len(framed))
	}
	if got, err := OpenAES(key, exam, framed); err != nil || string(got) != "paper" {
		t.Fatalf("open: %q %v", got, err)
	}
	if _, err := OpenAES(key, other, framed); !errors.Is(err, ErrOpen) {
		t.Error("opened under another exam")
	}
	if _, err := OpenAES(key[:16], exam, framed); err == nil {
		t.Error("accepted a short key")
	}
	if _, err := OpenAES(key, exam, framed[:20]); !errors.Is(err, ErrOpen) {
		t.Error("opened a short message")
	}
	// Two seals differ, because the nonce is random.
	again, _ := SealAES(key, exam, []byte("paper"))
	if bytes.Equal(framed, again) {
		t.Error("nonce repeated")
	}
}

func TestPadding(t *testing.T) {
	p, err := Pad([]byte("abc"), 16)
	if err != nil || len(p) != 16 || !bytes.Equal(p[:7], []byte{0, 0, 0, 3, 'a', 'b', 'c'}) {
		t.Fatalf("pad: %x %v", p, err)
	}
	if got, err := Unpad(p, 16); err != nil || string(got) != "abc" {
		t.Fatalf("unpad: %q %v", got, err)
	}
	if _, err := Pad(make([]byte, 13), 16); !errors.Is(err, ErrPadding) {
		t.Error("padded data that doesn't fit")
	}
	if _, err := Pad(make([]byte, 12), 16); err != nil {
		t.Errorf("exact fit refused: %v", err)
	}
	bad := append([]byte(nil), p...)
	bad[15] = 1
	if _, err := Unpad(bad, 16); !errors.Is(err, ErrPadding) {
		t.Error("accepted non-zero padding")
	}
	if _, err := Unpad(p[:15], 16); !errors.Is(err, ErrPadding) {
		t.Error("accepted a wrong size")
	}
	long := append([]byte(nil), p...)
	long[3] = 13
	if _, err := Unpad(long, 16); !errors.Is(err, ErrPadding) {
		t.Error("accepted a length beyond the space")
	}
}

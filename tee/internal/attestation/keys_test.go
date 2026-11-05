package attestation

import (
	"bytes"
	"crypto/elliptic"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math/big"
	"testing"

	"paperseal/tee/internal/encryption"
	"paperseal/tee/internal/hashing"
)

func TestEmbeddedRoot(t *testing.T) {
	root, err := GoogleRoot()
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(func() []byte { s := sha1.Sum(root.Raw); return s[:] }()); got != "b95120742c24e3aa34042e1c3ba3aad28b212321" {
		t.Fatalf("root SHA-1 fingerprint %s is not the one Google documents", got)
	}
	if root.Subject.CommonName != "Confidential Space Root CA" || !root.IsCA {
		t.Fatalf("unexpected root: %s", root.Subject)
	}
	if sha256.Sum256(root.Raw) == [32]byte{} {
		t.Fatal("unreachable")
	}
}

func TestKeysSignAndVerify(t *testing.T) {
	var exam [32]byte
	exam[0] = 7
	k, err := NewKeys(exam)
	if err != nil {
		t.Fatal(err)
	}
	if err := hashing.CheckPublicKey(k.PublicKey()); err != nil {
		t.Fatal(err)
	}
	if err := hashing.CheckPublicKey(k.EncryptionPublicKey()); err != nil {
		t.Fatal(err)
	}
	if string(k.PublicKey()) == string(k.EncryptionPublicKey()) {
		t.Fatal("signing and encryption keys must differ")
	}

	// The instance key signature verifies over the instanceKey message.
	m, err := hashing.InstanceKey(exam, k.EncryptionPublicKey())
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify(k.PublicKey(), m, k.InstanceKeySignature()); err != nil {
		t.Fatalf("instanceKey signature: %v", err)
	}

	// Many signatures: all low-s, all verify, and a flipped s fails.
	n := elliptic.P256().Params().N
	half := new(big.Int).Rsh(n, 1)
	other := hashing.ReleaseLog(exam, exam)
	for i := 0; i < 200; i++ {
		sig, err := k.Sign(m)
		if err != nil {
			t.Fatal(err)
		}
		s := new(big.Int).SetBytes(sig[32:])
		if s.Cmp(half) > 0 {
			t.Fatal("high s")
		}
		if err := Verify(k.PublicKey(), m, sig); err != nil {
			t.Fatal(err)
		}
		if err := Verify(k.PublicKey(), other, sig); !errors.Is(err, ErrBadSignature) {
			t.Fatal("verified under another message")
		}
		var flipped [64]byte
		copy(flipped[:], sig[:])
		new(big.Int).Sub(n, s).FillBytes(flipped[32:])
		if err := Verify(k.PublicKey(), m, flipped); !errors.Is(err, ErrBadSignature) {
			t.Fatal("accepted a high-s signature")
		}
	}
	// Another key doesn't verify.
	k2, _ := NewKeys(exam)
	sig, _ := k.Sign(m)
	if err := Verify(k2.PublicKey(), m, sig); !errors.Is(err, ErrBadSignature) {
		t.Fatal("verified under another key")
	}
}

func TestKeysOpenOnlyForTheirExam(t *testing.T) {
	var exam, other [32]byte
	exam[0], other[0] = 1, 2
	k, _ := NewKeys(exam)
	framed, err := encryption.Seal(encryption.PurposeRelease, k.EncryptionPublicKey(), exam, []byte("q"))
	if err != nil {
		t.Fatal(err)
	}
	if got, err := k.Open(encryption.PurposeRelease, framed); err != nil || string(got) != "q" {
		t.Fatalf("open: %v", err)
	}
	framed, _ = encryption.Seal(encryption.PurposeRelease, k.EncryptionPublicKey(), other, []byte("q"))
	if _, err := k.Open(encryption.PurposeRelease, framed); err == nil {
		t.Fatal("opened a message for another exam")
	}
}

func TestKeysOpenQuestionOnlyForItsSetter(t *testing.T) {
	var exam, other [32]byte
	exam[0], other[0] = 1, 2
	k, _ := NewKeys(exam)
	asha, _ := encryption.DeriveKey(bytes.Repeat([]byte{1}, 32))
	ben, _ := encryption.DeriveKey(bytes.Repeat([]byte{2}, 32))
	framed, err := encryption.SealQuestion(k.EncryptionPublicKey(), exam, asha.PublicKey(), []byte("q"))
	if err != nil {
		t.Fatal(err)
	}
	if got, err := k.OpenQuestion(asha.PublicKey(), framed); err != nil || string(got) != "q" {
		t.Fatalf("open: %v", err)
	}
	if _, err := k.OpenQuestion(ben.PublicKey(), framed); err == nil {
		t.Fatal("opened a question under another setter's passkey")
	}
	framed, _ = encryption.SealQuestion(k.EncryptionPublicKey(), other, asha.PublicKey(), []byte("q"))
	if _, err := k.OpenQuestion(asha.PublicKey(), framed); err == nil {
		t.Fatal("opened a question for another exam")
	}
}

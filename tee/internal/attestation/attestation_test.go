package attestation

import (
	"crypto/ecdh"
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"testing"
)

func TestNonce(t *testing.T) {
	s := make([]byte, 32)
	s[31] = 1
	priv, err := ecdh.P256().NewPrivateKey(s)
	if err != nil {
		t.Fatal(err)
	}
	pub := priv.PublicKey().Bytes()
	var examID [32]byte
	for i := range examID {
		examID[i] = 0x11
	}

	// Built by hand, separately from package hashing.
	// It is abi.encode(string tag, bytes key, bytes32 examId): three head words,
	// then the 30-byte tag and the 65-byte key, each with a length word and
	// padded to 32 bytes.
	word := func(n byte) []byte { return append(make([]byte, 31), n) }
	var preimage []byte
	preimage = append(preimage, word(0x60)...)
	preimage = append(preimage, word(0xa0)...)
	preimage = append(preimage, examID[:]...)
	preimage = append(preimage, word(30)...)
	preimage = append(preimage, "paperseal/v1/attestation-nonce"...)
	preimage = append(preimage, make([]byte, 2)...)
	preimage = append(preimage, word(65)...)
	preimage = append(preimage, pub...)
	preimage = append(preimage, make([]byte, 31)...)
	sum := sha256.Sum256(preimage)

	got, err := Nonce(pub, examID)
	if err != nil {
		t.Fatal(err)
	}
	if want := hex.EncodeToString(sum[:]); got != want {
		t.Fatalf("got %s want %s", got, want)
	}
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(got) {
		t.Fatalf("nonce %q is not 64 lowercase hex characters", got)
	}
}

func TestNonceRejectsCompressedKey(t *testing.T) {
	if _, err := Nonce(make([]byte, 33), [32]byte{}); err == nil {
		t.Fatal("accepted")
	}
}

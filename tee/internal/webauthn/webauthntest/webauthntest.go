// Package webauthntest is a software passkey that makes real ES256 signatures
// in WebAuthn format, like Chrome's virtual authenticator. It is for tests only.
package webauthntest

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"

	"paperseal/tee/internal/hashing"
	"paperseal/tee/internal/webauthn"
)

// Flags for authenticator data.
const (
	UP = 0x01
	UV = 0x04
	BE = 0x08
	BS = 0x10
)

// Passkey is a device-bound software passkey.
type Passkey struct {
	key *ecdsa.PrivateKey
	// Flags are written into every assertion. New sets UP and UV.
	Flags byte
	// Type is the clientDataJSON type. New sets webauthn.get.
	Type string
	// Encoding encodes the challenge. New sets unpadded base64url.
	Encoding *base64.Encoding
}

// New makes a passkey that behaves like a hardware-bound security key.
func New(t testing.TB) *Passkey {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &Passkey{key: k, Flags: UP | UV, Type: webauthn.TypeGet, Encoding: base64.RawURLEncoding}
}

// PublicKey is the 65-byte uncompressed passkey public key.
func (p *Passkey) PublicKey() []byte {
	k, err := p.key.PublicKey.ECDH()
	if err != nil {
		panic(err)
	}
	return k.Bytes()
}

// Sign answers a WebAuthn request whose challenge is the message hash.
func (p *Passkey) Sign(t testing.TB, m hashing.Message) webauthn.Assertion {
	t.Helper()
	sum := m.Sum()
	cd, err := json.Marshal(map[string]any{
		"type":        p.Type,
		"challenge":   p.Encoding.EncodeToString(sum[:]),
		"origin":      "https://paperseal.example",
		"crossOrigin": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	authData := make([]byte, 37)
	rpHash := sha256.Sum256([]byte("paperseal.example"))
	copy(authData, rpHash[:])
	authData[32] = p.Flags
	cdHash := sha256.Sum256(cd)
	signed := sha256.Sum256(append(append([]byte(nil), authData...), cdHash[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, p.key, signed[:])
	if err != nil {
		t.Fatal(err)
	}
	return webauthn.Assertion{AuthenticatorData: authData, ClientDataJSON: cd, Signature: sig}
}

// Package attestation binds this instance to its code. The eat_nonce encoding
// is real. Fetching a Google token and holding the instance key are not done
// yet, and their stubs return a not-implemented error.
package attestation

import (
	"context"
	"encoding/hex"

	"paperseal/tee/internal/hashing"
	"paperseal/tee/internal/notimpl"
)

// Nonce returns eat_nonce: the lowercase hex, with no 0x prefix, of the tagged
// hash of the instance public key and the exam ID.
func Nonce(instancePublicKey []byte, examID [32]byte) (string, error) {
	m, err := hashing.AttestationNonce(instancePublicKey, examID)
	if err != nil {
		return "", err
	}
	sum := m.Sum()
	return hex.EncodeToString(sum[:]), nil
}

// TokenType selects the Confidential Space token format.
type TokenType string

const (
	// TokenOIDC is for live checks.
	TokenOIDC TokenType = "OIDC"
	// TokenPKI is for anything published, so it can be checked later.
	TokenPKI TokenType = "PKI"
)

// Token is a Google-signed attestation token.
type Token struct {
	Type TokenType
	Raw  string
}

// TokenSource requests a token from the Confidential Space launcher.
type TokenSource interface {
	Token(ctx context.Context, tokenType TokenType, audience, nonce string) (Token, error)
}

// Signer is the instance key. It signs outputs as 64-byte r || s with low s.
type Signer interface {
	PublicKey() []byte
	Sign(ctx context.Context, m hashing.Message) ([64]byte, error)
}

// Launcher is the stub TokenSource.
type Launcher struct{}

// Token is not implemented.
func (Launcher) Token(context.Context, TokenType, string, string) (Token, error) {
	return Token{}, notimpl.New("attestation.Launcher.Token")
}

// InstanceKey is the stub Signer. It holds no key.
type InstanceKey struct{}

// PublicKey returns nil, because no key exists yet.
func (InstanceKey) PublicKey() []byte { return nil }

// Sign is not implemented.
func (InstanceKey) Sign(context.Context, hashing.Message) ([64]byte, error) {
	return [64]byte{}, notimpl.New("attestation.InstanceKey.Sign")
}

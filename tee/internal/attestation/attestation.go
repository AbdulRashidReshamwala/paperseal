// Package attestation binds this instance to its code. It holds the instance
// keys, asks the Confidential Space launcher for Google-signed tokens, and
// verifies published tokens. Outside Confidential Space there is no launcher, so
// the instance is unattested and no token is ever made up.
package attestation

import (
	"context"
	"encoding/hex"

	"paperseal/tee/internal/hashing"
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
	Sign(m hashing.Message) ([64]byte, error)
}

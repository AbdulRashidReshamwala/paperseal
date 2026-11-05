// Package webauthn checks passkey signatures as spec/api.md "Passkey
// Signatures" describes. A passkey signs a message hash as the WebAuthn
// challenge, and the TEE checks the ES256 signature with crypto/ecdsa and the
// fixed-layout authenticator data by hand. It needs no CBOR library, because
// the TEE never parses the attestation object unless attestation is required.
package webauthn

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"

	"paperseal/tee/internal/hashing"
	"paperseal/tee/internal/notimpl"
	"paperseal/tee/internal/spec"
)

// ClientData types for the two ceremonies.
const (
	TypeGet    = "webauthn.get"
	TypeCreate = "webauthn.create"
)

// Authenticator data flags, at byte 32.
const (
	flagUserPresent  = 0x01
	flagUserVerified = 0x04
	flagBackupElig   = 0x08
	flagBackupState  = 0x10
)

// authDataMin is the rpIdHash, the flags and the counter.
const authDataMin = 37

// Assertion is what a passkey returns for a signature.
type Assertion struct {
	AuthenticatorData []byte
	ClientDataJSON    []byte
	Signature         []byte // ES256, DER.
}

// ErrBad is the base of every rejection.
var ErrBad = errors.New("webauthn: invalid passkey signature")

func bad(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrBad, fmt.Sprintf(format, a...))
}

// Verify checks that the passkey signed the message hash. It checks the
// signature over authenticatorData || SHA-256(clientDataJSON), that the
// challenge is the base64url message hash, that type is ceremony, that user
// present and user verified are set, and that both backup flags are clear. It
// doesn't check origin or rpIdHash, because the passkey public key identifies the
// holder and the board serves the app anyway.
func Verify(passkeyPublicKey []byte, ceremony string, message hashing.Message, a Assertion) error {
	if err := hashing.CheckPublicKey(passkeyPublicKey); err != nil {
		return bad("%v", err)
	}
	var cd struct {
		Type      string `json:"type"`
		Challenge string `json:"challenge"`
	}
	if err := json.Unmarshal(a.ClientDataJSON, &cd); err != nil {
		return bad("clientDataJSON: %v", err)
	}
	if cd.Type != ceremony {
		return bad("type is %q, want %q", cd.Type, ceremony)
	}
	sum := message.Sum()
	if cd.Challenge != base64.RawURLEncoding.EncodeToString(sum[:]) {
		return bad("challenge is not the message hash")
	}
	if len(a.AuthenticatorData) < authDataMin {
		return bad("authenticator data is %d bytes", len(a.AuthenticatorData))
	}
	flags := a.AuthenticatorData[32]
	if flags&flagUserPresent == 0 {
		return bad("user presence is not set")
	}
	if flags&flagUserVerified == 0 {
		return bad("user verification is not set")
	}
	if flags&(flagBackupElig|flagBackupState) != 0 {
		return bad("a backup flag is set, so the passkey may be synced")
	}
	pub := &ecdsa.PublicKey{
		Curve: elliptic.P256(),
		X:     new(big.Int).SetBytes(passkeyPublicKey[1:33]),
		Y:     new(big.Int).SetBytes(passkeyPublicKey[33:]),
	}
	cdHash := sha256.Sum256(a.ClientDataJSON)
	signed := sha256.Sum256(append(append([]byte(nil), a.AuthenticatorData...), cdHash[:]...))
	// VerifyASN1 refuses malformed DER, including trailing bytes.
	if !ecdsa.VerifyASN1(pub, signed[:], a.Signature) {
		return bad("signature does not verify")
	}
	return nil
}

// AttestationResult says what the attestation check did, so nothing claims a
// check that didn't run.
type AttestationResult struct {
	// ChainChecked is true only if the attestation chain was verified.
	ChainChecked bool
}

// CheckAttestation applies webauthn.requireHardwareAttestation. When it is
// false the chain check is skipped, and the result says so. When it is true the
// check isn't implemented, so it refuses: the TEE can't verify an attestation
// chain yet, and it never claims it did.
func CheckAttestation(attestationObject []byte) (AttestationResult, error) {
	return checkAttestation(spec.C.WebAuthn.RequireHardwareAttestation, attestationObject)
}

func checkAttestation(require bool, _ []byte) (AttestationResult, error) {
	if require {
		return AttestationResult{}, notimpl.New("webauthn.CheckAttestation: hardware attestation chains " +
			"need a CBOR parser and the approved authenticator roots (AAGUIDs), which are not chosen yet")
	}
	return AttestationResult{ChainChecked: false}, nil
}

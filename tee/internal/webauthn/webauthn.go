// Package webauthn checks passkey signatures as spec/api.md "Passkey
// Signatures" describes. A passkey signs a message hash as the WebAuthn
// challenge, and the TEE checks the ES256 signature with crypto/ecdsa and the
// fixed-layout authenticator data by hand. A CBOR library reads the attestation
// object, and only when attestation is required.
package webauthn

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"

	"github.com/fxamacker/cbor/v2"

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

// ErrAttestation means an attestation object doesn't belong to the passkey.
var ErrAttestation = errors.New("webauthn: attestation does not belong to this passkey")

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

// CheckAttestation applies webauthn.requireSecurityKeyAttestation, which is about
// a security key's maker and not the TEE's attestation token. When it is
// false nothing is read, and the result says so. When it is true the object must
// belong to the passkey. The chain check after that isn't implemented, so it
// refuses: the TEE can't verify an attestation chain yet, and it never claims it
// did.
func CheckAttestation(attestationObject, passkeyPublicKey []byte) (AttestationResult, error) {
	return checkAttestation(spec.C.WebAuthn.RequireSecurityKeyAttestation, attestationObject, passkeyPublicKey)
}

func checkAttestation(require bool, attestationObject, passkeyPublicKey []byte) (AttestationResult, error) {
	if !require {
		return AttestationResult{ChainChecked: false}, nil
	}
	if err := checkAttestedKey(attestationObject, passkeyPublicKey); err != nil {
		return AttestationResult{}, err
	}
	return AttestationResult{}, notimpl.New("webauthn.CheckAttestation: security key attestation chains " +
		"need the approved authenticator roots (AAGUIDs), which are not chosen yet")
}

// Offsets in authenticator data with attested credential data: the rpIdHash,
// flags and counter, then the 16-byte AAGUID and the credential ID's length.
const (
	flagAttested  = 0x40
	credentialLen = authDataMin + 16
	credentialID  = credentialLen + 2
)

// COSE_Key labels and values for an ES256 key, from RFC 9053.
const (
	coseKty    = 1
	coseAlg    = 3
	coseCrv    = -1
	coseX      = -2
	coseY      = -3
	coseKtyEC2 = 2
	coseES256  = -7
	coseP256   = 1
	coordBytes = 32
)

// checkAttestedKey checks that the object's attested credential is passkeyPublicKey.
func checkAttestedKey(attestationObject, passkeyPublicKey []byte) error {
	var object struct {
		AuthData []byte `cbor:"authData"`
	}
	if err := cbor.Unmarshal(attestationObject, &object); err != nil {
		return fmt.Errorf("%w: the object doesn't read: %v", ErrAttestation, err)
	}
	data := object.AuthData
	if len(data) < credentialID || data[32]&flagAttested == 0 {
		return fmt.Errorf("%w: no attested credential", ErrAttestation)
	}
	end := credentialID + int(data[credentialLen])<<8 + int(data[credentialLen+1])
	if len(data) <= end {
		return fmt.Errorf("%w: the credential is cut short", ErrAttestation)
	}
	var key map[int]cbor.RawMessage
	// UnmarshalFirst, because extension data may follow the key.
	if _, err := cbor.UnmarshalFirst(data[end:], &key); err != nil {
		return fmt.Errorf("%w: the public key doesn't read: %v", ErrAttestation, err)
	}
	var kty, alg, crv int
	var x, y []byte
	for label, into := range map[int]any{coseKty: &kty, coseAlg: &alg, coseCrv: &crv, coseX: &x, coseY: &y} {
		if err := cbor.Unmarshal(key[label], into); err != nil {
			return fmt.Errorf("%w: the public key has no usable label %d", ErrAttestation, label)
		}
	}
	if kty != coseKtyEC2 || alg != coseES256 || crv != coseP256 || len(x) != coordBytes || len(y) != coordBytes {
		return fmt.Errorf("%w: not a P-256 ES256 key", ErrAttestation)
	}
	point := append(append([]byte{4}, x...), y...)
	if !bytes.Equal(point, passkeyPublicKey) {
		return fmt.Errorf("%w: it attests a different key", ErrAttestation)
	}
	return nil
}

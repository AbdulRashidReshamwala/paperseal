package webauthn

import (
	"errors"
	"testing"

	"github.com/fxamacker/cbor/v2"

	"paperseal/tee/internal/notimpl"
)

// attestation builds an attestation object for a P-256 key, as an authenticator does.
func attestation(t *testing.T, flags byte, x, y []byte) []byte {
	t.Helper()
	key, err := cbor.Marshal(map[int]any{coseKty: coseKtyEC2, coseAlg: coseES256, coseCrv: coseP256, coseX: x, coseY: y})
	if err != nil {
		t.Fatal(err)
	}
	data := make([]byte, credentialID)
	data[32] = flags
	data[credentialLen+1] = 4 // A 4-byte credential ID.
	data = append(append(data, 1, 2, 3, 4), key...)
	object, err := cbor.Marshal(map[string]any{"fmt": "none", "attStmt": map[string]any{}, "authData": data})
	if err != nil {
		t.Fatal(err)
	}
	return object
}

func point() (x, y, public []byte) {
	x, y = make([]byte, coordBytes), make([]byte, coordBytes)
	x[0], y[0] = 1, 2
	return x, y, append(append([]byte{4}, x...), y...)
}

func TestRequiredAttestationRefuses(t *testing.T) {
	x, y, public := point()
	res, err := checkAttestation(true, attestation(t, flagAttested, x, y), public)
	if !notimpl.Is(err) || res.ChainChecked {
		t.Fatalf("a matching object must reach the chain check, which is not implemented: %+v %v", res, err)
	}
	res, err = checkAttestation(false, nil, nil)
	if err != nil || res.ChainChecked {
		t.Fatalf("skipped: %+v %v", res, err)
	}
}

func TestAttestationMustBelongToThePasskey(t *testing.T) {
	x, y, public := point()
	other := append([]byte(nil), public...)
	other[64] ^= 1
	short := attestation(t, flagAttested, x[:31], y)
	for name, c := range map[string]struct{ object, key []byte }{
		"empty":         {nil, public},
		"not cbor":      {[]byte("nope"), public},
		"another key":   {attestation(t, flagAttested, x, y), other},
		"no credential": {attestation(t, 0, x, y), public},
		"short point":   {short, public},
	} {
		if _, err := checkAttestation(true, c.object, c.key); !errors.Is(err, ErrAttestation) {
			t.Errorf("%s: got %v", name, err)
		}
	}
}

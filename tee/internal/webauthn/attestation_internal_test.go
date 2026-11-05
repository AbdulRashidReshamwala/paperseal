package webauthn

import (
	"testing"

	"paperseal/tee/internal/notimpl"
)

func TestRequiredAttestationRefuses(t *testing.T) {
	res, err := checkAttestation(true, []byte("object"))
	if !notimpl.Is(err) || res.ChainChecked {
		t.Fatalf("required attestation must be not implemented and unchecked: %+v %v", res, err)
	}
	res, err = checkAttestation(false, nil)
	if err != nil || res.ChainChecked {
		t.Fatalf("skipped: %+v %v", res, err)
	}
}

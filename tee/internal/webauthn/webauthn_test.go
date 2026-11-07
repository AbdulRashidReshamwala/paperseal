package webauthn_test

import (
	"encoding/base64"
	"errors"
	"testing"

	"paperseal/tee/internal/hashing"
	"paperseal/tee/internal/notimpl"
	"paperseal/tee/internal/spec"
	"paperseal/tee/internal/webauthn"
	"paperseal/tee/internal/webauthn/webauthntest"
)

func message(t *testing.T, challenge byte) hashing.Message {
	t.Helper()
	m, err := hashing.ShareRelease([32]byte{1}, []byte{challenge})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestVerify(t *testing.T) {
	p := webauthntest.New(t)
	m := message(t, 1)
	a := p.Sign(t, m)
	if err := webauthn.Verify(p.PublicKey(), webauthn.TypeGet, m, a); err != nil {
		t.Fatal(err)
	}
	if err := webauthn.Verify(p.PublicKey(), webauthn.TypeCreate, m, a); !errors.Is(err, webauthn.ErrBad) {
		t.Error("accepted the wrong ceremony")
	}
	if err := webauthn.Verify(p.PublicKey(), webauthn.TypeGet, message(t, 2), a); !errors.Is(err, webauthn.ErrBad) {
		t.Error("accepted another message's challenge")
	}
	other := webauthntest.New(t)
	if err := webauthn.Verify(other.PublicKey(), webauthn.TypeGet, m, a); !errors.Is(err, webauthn.ErrBad) {
		t.Error("accepted another passkey")
	}
	if err := webauthn.Verify([]byte{1, 2}, webauthn.TypeGet, m, a); !errors.Is(err, webauthn.ErrBad) {
		t.Error("accepted a bad key")
	}

	// Tampering with each part breaks the signature.
	tamper := map[string]func(a *webauthn.Assertion){
		"signature":    func(a *webauthn.Assertion) { a.Signature = append([]byte(nil), a.Signature...); a.Signature[10] ^= 1 },
		"trailing DER": func(a *webauthn.Assertion) { a.Signature = append(append([]byte(nil), a.Signature...), 0) },
		"authData": func(a *webauthn.Assertion) {
			a.AuthenticatorData = append([]byte(nil), a.AuthenticatorData...)
			a.AuthenticatorData[3] ^= 1
		},
		"short authData": func(a *webauthn.Assertion) { a.AuthenticatorData = a.AuthenticatorData[:36] },
		"clientData":     func(a *webauthn.Assertion) { a.ClientDataJSON = append([]byte(" "), a.ClientDataJSON...) },
		"not json":       func(a *webauthn.Assertion) { a.ClientDataJSON = []byte("nope") },
	}
	for name, f := range tamper {
		b := a
		f(&b)
		if err := webauthn.Verify(p.PublicKey(), webauthn.TypeGet, m, b); !errors.Is(err, webauthn.ErrBad) {
			t.Errorf("%s: accepted (%v)", name, err)
		}
	}
}

func TestFlags(t *testing.T) {
	m := message(t, 1)
	cases := []struct {
		name  string
		flags byte
		ok    bool
	}{
		{"present and verified", webauthntest.UP | webauthntest.UV, true},
		{"not present", webauthntest.UV, false},
		{"not verified", webauthntest.UP, false},
		{"backup eligible", webauthntest.UP | webauthntest.UV | webauthntest.BE, false},
		{"backed up", webauthntest.UP | webauthntest.UV | webauthntest.BS, false},
		{"both backup flags", webauthntest.UP | webauthntest.UV | webauthntest.BE | webauthntest.BS, false},
	}
	for _, c := range cases {
		p := webauthntest.New(t)
		p.Flags = c.flags
		err := webauthn.Verify(p.PublicKey(), webauthn.TypeGet, m, p.Sign(t, m))
		if (err == nil) != c.ok {
			t.Errorf("%s: err %v, want ok=%v", c.name, err, c.ok)
		}
	}
}

func TestChallengeMustBeUnpaddedBase64URL(t *testing.T) {
	m := message(t, 1)
	for name, enc := range map[string]*base64.Encoding{
		"padded":   base64.URLEncoding,
		"standard": base64.StdEncoding,
	} {
		p := webauthntest.New(t)
		p.Encoding = enc
		if err := webauthn.Verify(p.PublicKey(), webauthn.TypeGet, m, p.Sign(t, m)); err == nil {
			t.Errorf("%s challenge accepted", name)
		}
	}
}

func TestAttestationIsNeverClaimed(t *testing.T) {
	// With the demo setting, the chain check is skipped and says so.
	res, err := webauthn.CheckAttestation([]byte("anything"), nil)
	if spec.C.WebAuthn.RequireSecurityKeyAttestation {
		if !notimpl.Is(err) {
			t.Fatalf("required attestation must be not implemented, got %v", err)
		}
		return
	}
	if err != nil || res.ChainChecked {
		t.Fatalf("skipped check: %+v %v", res, err)
	}
}

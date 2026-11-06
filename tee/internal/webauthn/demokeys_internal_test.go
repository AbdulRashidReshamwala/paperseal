package webauthn

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"paperseal/tee/internal/hashing"
)

// The demo's planted keys (packages/keys/src/demo.ts) are a software
// authenticator, so the sealed machine must accept them for real, by the checks
// it gives any key. spec/fixtures/demo-keys.json is what the TypeScript key code
// sent, and each message below is built again here, as the handlers build it, so
// nothing is taken from the fixture but what a request carries.

type hexBytes []byte

func (b *hexBytes) UnmarshalJSON(raw []byte) error {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return err
	}
	decoded, err := hex.DecodeString(strings.TrimPrefix(s, "0x"))
	*b = decoded
	return err
}

type demoRequest struct {
	Owner             string   `json:"owner"`
	InviteTag         hexBytes `json:"inviteTag"`
	Challenge         hexBytes `json:"challenge"`
	PasskeyPublicKey  hexBytes `json:"passkeyPublicKey"`
	DerivedPublicKey  hexBytes `json:"derivedPublicKey"`
	AttestationObject hexBytes `json:"attestationObject"`
	QuestionHash      hexBytes `json:"questionHash"`
	AuthenticatorData hexBytes `json:"authenticatorData"`
	ClientDataJSON    hexBytes `json:"clientDataJSON"`
	Signature         hexBytes `json:"signature"`
}

func (r demoRequest) assertion() Assertion {
	return Assertion{AuthenticatorData: r.AuthenticatorData, ClientDataJSON: r.ClientDataJSON, Signature: r.Signature}
}

func demoFixture(t *testing.T) (examID [32]byte, setter, byName, question, release demoRequest) {
	t.Helper()
	raw, err := os.ReadFile("../../../spec/fixtures/demo-keys.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		ExamID   hexBytes    `json:"examId"`
		Setter   demoRequest `json:"setter"`
		ByName   demoRequest `json:"byName"`
		Question demoRequest `json:"question"`
		Release  demoRequest `json:"release"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return [32]byte(f.ExamID), f.Setter, f.ByName, f.Question, f.Release
}

func registrationMessage(t *testing.T, r demoRequest) hashing.Message {
	t.Helper()
	m, err := hashing.Registration(r.DerivedPublicKey, []byte(r.Owner), r.Challenge, [32]byte(r.InviteTag))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestDemoKeysPassVerify(t *testing.T) {
	examID, setter, byName, question, release := demoFixture(t)

	questionMessage, err := hashing.QuestionSubmission(examID, question.Challenge, [32]byte(question.QuestionHash))
	if err != nil {
		t.Fatal(err)
	}
	releaseMessage, err := hashing.ShareRelease(examID, release.Challenge)
	if err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]struct {
		request demoRequest
		message hashing.Message
	}{
		"setter registration":  {setter, registrationMessage(t, setter)},
		"registration by name": {byName, registrationMessage(t, byName)},
		"question":             {question, questionMessage},
		"share release":        {release, releaseMessage},
	} {
		if err := Verify(c.request.PasskeyPublicKey, TypeGet, c.message, c.request.assertion()); err != nil {
			t.Errorf("%s: %v", name, err)
		}
		// The same bytes must fail once anything signed changes, so this is the real check.
		tampered := c.request.assertion()
		tampered.ClientDataJSON = append([]byte(nil), tampered.ClientDataJSON...)
		tampered.ClientDataJSON[len(tampered.ClientDataJSON)-2] ^= 1
		if err := Verify(c.request.PasskeyPublicKey, TypeGet, c.message, tampered); !errors.Is(err, ErrBad) {
			t.Errorf("%s: accepted changed client data: %v", name, err)
		}
		flags := c.request.assertion()
		flags.AuthenticatorData = append([]byte(nil), flags.AuthenticatorData...)
		flags.AuthenticatorData[32] ^= flagBackupElig
		if err := Verify(c.request.PasskeyPublicKey, TypeGet, c.message, flags); !errors.Is(err, ErrBad) {
			t.Errorf("%s: accepted a backup flag: %v", name, err)
		}
		other := append([]byte(nil), setter.PasskeyPublicKey...)
		if name == "setter registration" || name == "question" {
			other = byName.PasskeyPublicKey
		}
		if err := Verify(other, TypeGet, c.message, c.request.assertion()); !errors.Is(err, ErrBad) {
			t.Errorf("%s: accepted another planted key: %v", name, err)
		}
	}
}

// Every setter in demo mode registers the same way, each with their own key.
func TestDemoSettersPassVerify(t *testing.T) {
	raw, err := os.ReadFile("../../../spec/fixtures/demo-keys.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Setter       demoRequest   `json:"setter"`
		OtherSetters []demoRequest `json:"otherSetters"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.OtherSetters) != 4 {
		t.Fatalf("the fixture has %d other setters, want 4", len(f.OtherSetters))
	}
	seen := map[string]bool{string(f.Setter.PasskeyPublicKey): true}
	for i, setter := range f.OtherSetters {
		if seen[string(setter.PasskeyPublicKey)] {
			t.Errorf("setter %d shares a key with another setter", i+2)
		}
		seen[string(setter.PasskeyPublicKey)] = true
		message := registrationMessage(t, setter)
		if err := Verify(setter.PasskeyPublicKey, TypeGet, message, setter.assertion()); err != nil {
			t.Errorf("setter %d: %v", i+2, err)
		}
		if err := checkAttestedKey(setter.AttestationObject, setter.PasskeyPublicKey); err != nil {
			t.Errorf("setter %d: %v", i+2, err)
		}
		if err := Verify(f.Setter.PasskeyPublicKey, TypeGet, message, setter.assertion()); !errors.Is(err, ErrBad) {
			t.Errorf("setter %d: accepted under another setter's key: %v", i+2, err)
		}
	}
}

func TestDemoKeysAreForLocalhost(t *testing.T) {
	_, setter, _, _, _ := demoFixture(t)
	rpHash := sha256.Sum256([]byte("localhost"))
	if [32]byte(setter.AuthenticatorData[:32]) != rpHash {
		t.Fatal("authenticator data does not carry the rpIdHash of localhost")
	}
}

func TestDemoAttestationObjectHoldsThePlantedKey(t *testing.T) {
	_, setter, _, _, _ := demoFixture(t)
	if err := checkAttestedKey(setter.AttestationObject, setter.PasskeyPublicKey); err != nil {
		t.Fatal(err)
	}
	other := append([]byte(nil), setter.PasskeyPublicKey...)
	other[64] ^= 1
	if err := checkAttestedKey(setter.AttestationObject, other); !errors.Is(err, ErrAttestation) {
		t.Fatalf("accepted another key: %v", err)
	}
}

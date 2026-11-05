package attestation_test

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"paperseal/tee/internal/attestation"
	"paperseal/tee/internal/attestation/attestationtest"
	"paperseal/tee/internal/settings"
)

func claims(t *testing.T, e settings.Exam, pub []byte, digest [32]byte, iat time.Time) map[string]any {
	nonce, err := attestation.Nonce(pub, e.ExamID)
	if err != nil {
		t.Fatal(err)
	}
	return attestationtest.GoodClaims(t, e, nonce, digest, iat)
}

func TestVerifyPKI(t *testing.T) {
	now := time.Now()
	pki := attestationtest.NewPKI(t, now.Add(-24*time.Hour), now.Add(24*time.Hour))
	v := pki.Verifier()
	e := attestationtest.TestExam(t)
	k, _ := attestation.NewKeys(e.ExamID)
	var digest [32]byte
	digest[0] = 0xab
	want := attestation.Expect{Exam: e, ImageDigest: digest, InstancePublicKey: k.PublicKey()}
	hdr := func() map[string]any { return map[string]any{"alg": "RS256"} }

	tok := pki.Token(t, hdr(), claims(t, e, k.PublicKey(), digest, now))
	if _, err := v.VerifyPKI(tok, want); err != nil {
		t.Fatalf("good token: %v", err)
	}

	// A published token is a record, so an expired one still verifies.
	old := claims(t, e, k.PublicKey(), digest, now.Add(-2*time.Hour))
	if _, err := v.VerifyPKI(pki.Token(t, hdr(), old), want); err != nil {
		t.Fatalf("expired token must pass as a record: %v", err)
	}

	mutate := func(name string, f func(c map[string]any)) {
		t.Run(name, func(t *testing.T) {
			c := claims(t, e, k.PublicKey(), digest, now)
			f(c)
			if _, err := v.VerifyPKI(pki.Token(t, hdr(), c), want); err == nil {
				t.Fatal("accepted")
			}
		})
	}
	sub := func(c map[string]any) map[string]any { return c["submods"].(map[string]any) }
	cont := func(c map[string]any) map[string]any { return sub(c)["container"].(map[string]any) }
	mutate("iss", func(c map[string]any) { c["iss"] = "https://evil" })
	mutate("aud", func(c map[string]any) { c["aud"] = "other" })
	mutate("swname", func(c map[string]any) { c["swname"] = "X" })
	mutate("dbgstat", func(c map[string]any) { c["dbgstat"] = "enabled" })
	mutate("hwmodel", func(c map[string]any) { c["hwmodel"] = "GCP_SHIELDED_VM" })
	mutate("secboot", func(c map[string]any) { c["secboot"] = false })
	mutate("support", func(c map[string]any) {
		sub(c)["confidential_space"] = map[string]any{"support_attributes": []string{"LATEST"}}
	})
	mutate("digest", func(c map[string]any) { cont(c)["image_digest"] = "sha256:" + strings.Repeat("00", 32) })
	mutate("args", func(c map[string]any) { cont(c)["args"] = []string{"/tee", "--exam-id=0x00"} })
	mutate("env", func(c map[string]any) { cont(c)["env"] = map[string]string{"SECRET": "1"} })
	mutate("cmd_override", func(c map[string]any) { cont(c)["cmd_override"] = []string{"/bin/sh"} })
	mutate("nonce", func(c map[string]any) { c["eat_nonce"] = []string{strings.Repeat("0", 64)} })
	mutate("no iat", func(c map[string]any) { delete(c, "iat") })

	// Another instance key fails the nonce binding.
	k2, _ := attestation.NewKeys(e.ExamID)
	if _, err := v.VerifyPKI(tok, attestation.Expect{Exam: e, ImageDigest: digest, InstancePublicKey: k2.PublicKey()}); err == nil {
		t.Fatal("accepted a token for another instance key")
	}
	// Other settings fail the args check.
	e2 := e
	e2.Delta = 1801
	if _, err := v.VerifyPKI(tok, attestation.Expect{Exam: e2, ImageDigest: digest, InstancePublicKey: k.PublicKey()}); err == nil {
		t.Fatal("accepted a token for other settings")
	}

	// Header and signature.
	if _, err := v.VerifyPKI(pki.Token(t, map[string]any{"alg": "none"}, claims(t, e, k.PublicKey(), digest, now)), want); err == nil {
		t.Fatal("accepted alg none")
	}
	parts := strings.Split(tok, ".")
	if _, err := v.VerifyPKI(parts[0]+"."+parts[1]+"."+base64.RawURLEncoding.EncodeToString([]byte("junk")), want); err == nil {
		t.Fatal("accepted a bad signature")
	}
	if _, err := v.VerifyPKI("a.b", want); err == nil {
		t.Fatal("accepted a malformed token")
	}
	// A chain from another root.
	other := attestationtest.NewPKI(t, now.Add(-time.Hour), now.Add(time.Hour))
	if _, err := v.VerifyPKI(other.Token(t, hdr(), claims(t, e, k.PublicKey(), digest, now)), want); err == nil {
		t.Fatal("accepted another root")
	}
	// A chain not valid as of iat.
	if _, err := v.VerifyPKI(pki.Token(t, hdr(), claims(t, e, k.PublicKey(), digest, now.Add(-72*time.Hour))), want); err == nil {
		t.Fatal("accepted a chain that was not valid at iat")
	}
	// Two certificates only.
	two := hdr()
	two["x5c"] = []string{base64.StdEncoding.EncodeToString(pki.LeafDER), base64.StdEncoding.EncodeToString(pki.RootDER)}
	if _, err := v.VerifyPKI(pki.Token(t, two, claims(t, e, k.PublicKey(), digest, now)), want); err == nil {
		t.Fatal("accepted a short chain")
	}
}

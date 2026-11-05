package attestation

import (
	"encoding/hex"
	"encoding/json"
	"maps"
	"os"
	"slices"
	"strings"
	"testing"

	"paperseal/tee/internal/settings"
)

// The fixture is the claims of a real Confidential Space token. Its settings
// are rebuilt from its own cmd_override, so the checks are tested against the
// real shape and not one made up here.
func TestRealClaimsFixture(t *testing.T) {
	raw, err := os.ReadFile("../../../spec/fixtures/confidential-space-claims.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var c claimsJSON
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	k := &c.Submods.Container
	exam, err := settings.Parse(k.CmdOverride)
	if err != nil {
		t.Fatalf("fixture cmd_override: %v", err)
	}
	var digest [32]byte
	d, err := hex.DecodeString(strings.TrimPrefix(k.ImageDigest, "sha256:"))
	if err != nil || len(d) != 32 {
		t.Fatalf("fixture image_digest %q", k.ImageDigest)
	}
	copy(digest[:], d)
	k0, err := NewKeys(exam.ExamID)
	if err != nil {
		t.Fatal(err)
	}
	pub := k0.PublicKey()
	nonce, err := Nonce(pub, exam.ExamID)
	if err != nil {
		t.Fatal(err)
	}
	// The real nonce binds a real key we don't have, so substitute ours.
	c.Nonce, _ = json.Marshal([]string{nonce})
	want := Expect{Exam: exam, ImageDigest: digest, InstancePublicKey: pub, Bucket: "paperseal-demo-paperseal-exams"}

	if err := checkClaims(c, want); err != nil {
		t.Fatalf("real claims rejected: %v", err)
	}

	// Each change below must fail, on a fresh copy of the claims.
	mutate := func(name string, f func(c *claimsJSON)) {
		t.Run(name, func(t *testing.T) {
			var m claimsJSON
			if err := json.Unmarshal(raw, &m); err != nil {
				t.Fatal(err)
			}
			m.Nonce = c.Nonce
			f(&m)
			if checkClaims(m, want) == nil {
				t.Fatal("accepted")
			}
		})
	}
	mutate("one cmd_override arg", func(m *claimsJSON) {
		m.Submods.Container.CmdOverride = slices.Clone(m.Submods.Container.CmdOverride)
		m.Submods.Container.CmdOverride[2] = "--delta=601"
	})
	mutate("one args arg", func(m *claimsJSON) {
		m.Submods.Container.Args = slices.Clone(m.Submods.Container.Args)
		m.Submods.Container.Args[3] = "--delta=601"
	})
	mutate("extra env_override key", func(m *claimsJSON) {
		e := maps.Clone(m.Submods.Container.EnvOverride)
		e["EXTRA"] = "1"
		m.Submods.Container.EnvOverride = e
	})
	mutate("dbgstat", func(m *claimsJSON) { m.DbgStat = "enabled" })
}

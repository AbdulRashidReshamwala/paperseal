package vectors

import (
	"bytes"
	"encoding/hex"
	"errors"
	"flag"
	"os"
	"strings"
	"testing"

	"paperseal/tee/internal/approvedlist"
	"paperseal/tee/internal/criteria"
)

const path = "../../testdata/vectors.json"

var update = flag.Bool("update", false, "rewrite testdata/vectors.json")

// A change to the encoding fails here, so it can't reach other languages
// unnoticed.
func TestVectorsAreCurrent(t *testing.T) {
	f, err := Build()
	if err != nil {
		t.Fatal(err)
	}
	got, err := Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	if *update {
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("testdata/vectors.json is stale: if the change is deliberate, run go test ./internal/vectors -update")
	}
}

// The sample must parse and be canonical, and fail only on its counts, as the
// file says.
func TestSampleFailsOnlyOnHolderCounts(t *testing.T) {
	f, err := Build()
	if err != nil {
		t.Fatal(err)
	}
	entries, err := hex.DecodeString(strings.TrimPrefix(f.ApprovedList.Entries, "0x"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := approvedlist.Decode(entries); !errors.Is(err, approvedlist.ErrHolderCount) {
		t.Fatalf("want the holder count rejection, got %v", err)
	}
}

func TestCriteriaSampleDecodes(t *testing.T) {
	f, err := Build()
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := hex.DecodeString(strings.TrimPrefix(f.Criteria.Encoded, "0x"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := criteria.Decode(encoded); err != nil {
		t.Fatal(err)
	}
}

func TestSampleHasOneEntryPerRole(t *testing.T) {
	seen := map[approvedlist.Role]int{}
	for _, e := range SamplePerRole() {
		seen[e.Role]++
	}
	for _, role := range []approvedlist.Role{
		approvedlist.RoleSetter, approvedlist.RoleNeutral, approvedlist.RoleCentreHolder, approvedlist.RoleCentre,
	} {
		if seen[role] != 1 {
			t.Errorf("role %d: %d entries", role, seen[role])
		}
	}
}

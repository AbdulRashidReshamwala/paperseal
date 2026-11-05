package spec

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// The embedded copy must be byte-identical to the root file.
func TestConstantsMatchRoot(t *testing.T) {
	root, err := os.ReadFile("../../../spec/constants.json")
	if err != nil {
		t.Fatalf("read root constants: %v", err)
	}
	if !bytes.Equal(root, raw) {
		t.Fatal("internal/spec/constants.json differs from spec/constants.json: run go generate ./internal/spec")
	}
}

// Every key in the JSON must reach the struct, so a new constant can't be
// silently ignored by the Go side.
func TestStructCoversEveryKey(t *testing.T) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var c Constants
	if err := dec.Decode(&c); err != nil {
		t.Fatalf("constants.json has a key the struct lacks: %v", err)
	}
}

func TestDomainTagsAreDistinctAndPrefixed(t *testing.T) {
	var tags map[string]string
	b, err := json.Marshal(C.DomainTags)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &tags); err != nil {
		t.Fatal(err)
	}
	if len(tags) != 11 {
		t.Fatalf("got %d tags, want 11", len(tags))
	}
	seen := map[string]bool{}
	for name, tag := range tags {
		if !strings.HasPrefix(tag, "paperseal/v1/") {
			t.Errorf("%s: tag %q lacks the paperseal/v1/ prefix", name, tag)
		}
		if strings.IndexByte(tag, 0) >= 0 {
			t.Errorf("%s: tag contains a zero byte", name)
		}
		if seen[tag] {
			t.Errorf("duplicate tag %q", tag)
		}
		seen[tag] = true
	}
}

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

func TestReadBlockIsExactlyOneOfTheTwoValues(t *testing.T) {
	var c Constants
	for _, ok := range []string{"latest", "finalized"} {
		c.Chain.ReadBlock = ok
		if err := c.validate(); err != nil {
			t.Errorf("%q refused: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "safe", "pending", "earliest", "Latest", "FINALIZED", " latest", "latest ", "0x10"} {
		c.Chain.ReadBlock = bad
		if err := c.validate(); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

// The check runs when the embedded file is parsed, so a bad value stops every
// binary at startup. A file without the key is refused too.
func TestBadReadBlockStopsStartup(t *testing.T) {
	for name, doc := range map[string]string{
		"wrong value": `{"chain":{"readBlock":"safe"}}`,
		"missing key": `{"chain":{}}`,
	} {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if r := recover(); r == nil {
					t.Fatal("mustParse did not panic")
				}
			}()
			mustParse([]byte(doc))
		})
	}
	if c := mustParse([]byte(`{"chain":{"readBlock":"finalized"}}`)); c.Chain.ReadBlock != "finalized" {
		t.Fatalf("readBlock %q", c.Chain.ReadBlock)
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
	if len(tags) != 13 {
		t.Fatalf("got %d tags, want 13", len(tags))
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

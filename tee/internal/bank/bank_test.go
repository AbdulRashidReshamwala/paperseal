package bank

import (
	"errors"
	"testing"

	"paperseal/tee/internal/criteria"
	"paperseal/tee/internal/encryption"
	"paperseal/tee/internal/spec"
)

var crit = criteria.Criteria{MaxSetterPercent: 50, MinBankMultiple: 2, Topics: []criteria.Topic{{Name: "algebra", Questions: 1}}}

func padded(t *testing.T, s string) []byte {
	t.Helper()
	p, err := encryption.Pad([]byte(s), spec.C.Padding.QuestionBytes)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestParse(t *testing.T) {
	topic, text, err := Parse(padded(t, `{"topic":"algebra","text":"Solve x."}`), crit)
	if err != nil || topic != "algebra" || text != "Solve x." {
		t.Fatalf("parse: %q %q %v", topic, text, err)
	}
	bad := map[string]string{
		"extra field":   `{"topic":"algebra","text":"a","x":1}`,
		"missing text":  `{"topic":"algebra"}`,
		"missing topic": `{"text":"a"}`,
		"empty text":    `{"topic":"algebra","text":"  \n"}`,
		"not json":      `hello`,
		"trailing data": `{"topic":"algebra","text":"a"} {}`,
		"wrong type":    `{"topic":"algebra","text":5}`,
		"array":         `[]`,
		"null":          `null`,
		"invalid UTF-8": "{\"topic\":\"algebra\",\"text\":\"\xff\"}",
	}
	for name, s := range bad {
		if _, _, err := Parse(padded(t, s), crit); !errors.Is(err, ErrFormat) {
			t.Errorf("%s: got %v", name, err)
		}
	}
	if _, _, err := Parse(padded(t, `{"topic":"geometry","text":"a"}`), crit); !errors.Is(err, ErrUnknownTopic) {
		t.Errorf("unknown topic: %v", err)
	}
	// Wrong size and non-zero padding are format errors.
	if _, _, err := Parse([]byte("short"), crit); !errors.Is(err, ErrFormat) {
		t.Errorf("short: %v", err)
	}
	p := padded(t, `{"topic":"algebra","text":"a"}`)
	p[len(p)-1] = 1
	if _, _, err := Parse(p, crit); !errors.Is(err, ErrFormat) {
		t.Errorf("dirty padding: %v", err)
	}
}

func TestAddRejectsDuplicatesAndClosed(t *testing.T) {
	b := New()
	q := Question{Passkey: []byte{1}, Topic: "algebra", Text: "What is x?", Hash: [32]byte{1}}
	if err := b.Add(q); err != nil {
		t.Fatal(err)
	}
	// The same ciphertext again.
	q2 := q
	q2.Text = "other"
	if err := b.Add(q2); !errors.Is(err, ErrDuplicate) {
		t.Errorf("same ciphertext: %v", err)
	}
	// The same text from another setter, differently spaced and cased.
	q3 := Question{Passkey: []byte{2}, Topic: "algebra", Text: "  what IS\tx? ", Hash: [32]byte{3}}
	if err := b.Add(q3); !errors.Is(err, ErrDuplicate) {
		t.Errorf("same text: %v", err)
	}
	if err := b.Add(Question{Passkey: []byte{2}, Topic: "algebra", Text: "Another", Hash: [32]byte{4}}); err != nil {
		t.Fatal(err)
	}
	if b.Count() != 2 {
		t.Fatalf("count %d", b.Count())
	}
	got := b.Close()
	if len(got) != 2 {
		t.Fatalf("closed bank has %d", len(got))
	}
	if err := b.Add(Question{Text: "late", Hash: [32]byte{9}}); !errors.Is(err, ErrClosed) {
		t.Errorf("after close: %v", err)
	}
	if len(b.Close()) != 2 {
		t.Error("second Close changed the bank")
	}
}

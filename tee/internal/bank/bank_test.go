package bank

import (
	"errors"
	"fmt"
	"slices"
	"strings"
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
	topic, text, options, err := Parse(padded(t, `{"topic":"algebra","text":"Solve x."}`), crit)
	if err != nil || topic != "algebra" || text != "Solve x." || options != nil {
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
		if _, _, _, err := Parse(padded(t, s), crit); !errors.Is(err, ErrFormat) {
			t.Errorf("%s: got %v", name, err)
		}
	}
	if _, _, _, err := Parse(padded(t, `{"topic":"geometry","text":"a"}`), crit); !errors.Is(err, ErrUnknownTopic) {
		t.Errorf("unknown topic: %v", err)
	}
	// Wrong size and non-zero padding are format errors.
	if _, _, _, err := Parse([]byte("short"), crit); !errors.Is(err, ErrFormat) {
		t.Errorf("short: %v", err)
	}
	p := padded(t, `{"topic":"algebra","text":"a"}`)
	p[len(p)-1] = 1
	if _, _, _, err := Parse(p, crit); !errors.Is(err, ErrFormat) {
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
	// The same setter again, differently spaced and cased.
	q3 := Question{Passkey: []byte{1}, Topic: "algebra", Text: "  what IS\tx? ", Hash: [32]byte{3}}
	if err := b.Add(q3); !errors.Is(err, ErrDuplicate) {
		t.Errorf("same text, same setter: %v", err)
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

// Duplicates are refused for the same setter only, so a setter can't learn
// whether someone else already submitted a question, by guessing its text or
// replaying its ciphertext.
func TestDuplicatesArePerSetterOnly(t *testing.T) {
	b := New()
	if err := b.Add(Question{Passkey: []byte{1}, Topic: "algebra", Text: "What is x?", Hash: [32]byte{1}}); err != nil {
		t.Fatal(err)
	}
	if err := b.Add(Question{Passkey: []byte{2}, Topic: "algebra", Text: "  what IS\tx? ", Hash: [32]byte{3}}); err != nil {
		t.Errorf("same text from another setter was refused, which leaks that it exists: %v", err)
	}
	if err := b.Add(Question{Passkey: []byte{3}, Topic: "algebra", Text: "Other", Hash: [32]byte{1}}); err != nil {
		t.Errorf("same ciphertext hash from another setter was refused: %v", err)
	}
	if err := b.Add(Question{Passkey: []byte{2}, Topic: "algebra", Text: "what is x?", Hash: [32]byte{5}}); !errors.Is(err, ErrDuplicate) {
		t.Errorf("same setter, same text: %v", err)
	}
	if b.Count() != 3 {
		t.Fatalf("count %d", b.Count())
	}
}

func TestWipeClearsTheBank(t *testing.T) {
	b := New()
	pass := []byte{1, 2, 3}
	for i := range 5 {
		if err := b.Add(Question{Passkey: pass, Topic: "algebra", Text: fmt.Sprint("secret ", i), Hash: [32]byte{byte(i + 1)}}); err != nil {
			t.Fatal(err)
		}
	}
	held := b.list // The slice the bank keeps.
	heldPass := held[0].Passkey
	b.Wipe()
	if b.Count() != 0 || len(b.seen) != 0 || b.list != nil {
		t.Fatalf("bank kept %d questions, %d seen", b.Count(), len(b.seen))
	}
	for i, q := range held {
		if q.Text != "" || q.Hash != ([32]byte{}) || q.Topic != "" {
			t.Fatalf("question %d left behind: %+v", i, q)
		}
	}
	for _, c := range heldPass {
		if c != 0 {
			t.Fatal("passkey bytes kept")
		}
	}
	if len(b.Close()) != 0 {
		t.Fatal("Close returns questions after Wipe")
	}
	if err := b.Add(Question{Passkey: pass, Text: "late", Hash: [32]byte{9}}); !errors.Is(err, ErrClosed) {
		t.Fatalf("Add after Wipe: %v", err)
	}
}

func TestParseMultipleChoice(t *testing.T) {
	topic, text, options, err := Parse(padded(t, `{"topic":"algebra","text":"Pick.","options":["b","a","<c>","d"]}`), crit)
	if err != nil || topic != "algebra" || text != "Pick." {
		t.Fatalf("parse: %q %q %v", topic, text, err)
	}
	if !slices.Equal(options, []string{"b", "a", "<c>", "d"}) {
		t.Fatalf("options %q", options)
	}
	// The limits are inclusive, and read from the constants.
	lim := spec.C.Limits
	if lim.QuestionOptionsMin < 2 || lim.QuestionOptionsMax < lim.QuestionOptionsMin {
		t.Fatalf("limits %d..%d", lim.QuestionOptionsMin, lim.QuestionOptionsMax)
	}
	for _, n := range []int{lim.QuestionOptionsMin, lim.QuestionOptionsMax} {
		if _, _, got, err := Parse(padded(t, optionsDoc(n)), crit); err != nil || len(got) != n {
			t.Errorf("%d options: %v %v", n, got, err)
		}
	}
}

func optionsDoc(n int) string {
	var opts []string
	for i := range n {
		opts = append(opts, fmt.Sprintf("%q", fmt.Sprintf("option %d", i)))
	}
	return `{"topic":"algebra","text":"Pick.","options":[` + strings.Join(opts, ",") + `]}`
}

func TestParseRefusesBadOptions(t *testing.T) {
	lim := spec.C.Limits
	bad := map[string]string{
		"null":              `{"topic":"algebra","text":"a","options":null}`,
		"empty":             `{"topic":"algebra","text":"a","options":[]}`,
		"too few":           optionsDoc(lim.QuestionOptionsMin - 1),
		"too many":          optionsDoc(lim.QuestionOptionsMax + 1),
		"blank":             `{"topic":"algebra","text":"a","options":["x",""]}`,
		"blank whitespace":  `{"topic":"algebra","text":"a","options":["x"," \t\n"]}`,
		"duplicate":         `{"topic":"algebra","text":"a","options":["x","y","x"]}`,
		"not a list":        `{"topic":"algebra","text":"a","options":"x"}`,
		"object":            `{"topic":"algebra","text":"a","options":{}}`,
		"non-string option": `{"topic":"algebra","text":"a","options":["x",1]}`,
		"null option":       `{"topic":"algebra","text":"a","options":["x",null]}`,
		"unknown key":       `{"topic":"algebra","text":"a","options":["x","y"],"answer":"x"}`,
		"unknown key alone": `{"topic":"algebra","text":"a","choices":["x","y"]}`,
	}
	for name, s := range bad {
		if _, _, _, err := Parse(padded(t, s), crit); !errors.Is(err, ErrFormat) {
			t.Errorf("%s: got %v", name, err)
		}
	}
	// An unknown topic is still reported as one, with good options.
	if _, _, _, err := Parse(padded(t, `{"topic":"geometry","text":"a","options":["x","y"]}`), crit); !errors.Is(err, ErrUnknownTopic) {
		t.Errorf("unknown topic: %v", err)
	}
}

// Options differing only in case or spacing are distinct, because the spec says
// no two are equal.
func TestParseTreatsOptionsAsExactStrings(t *testing.T) {
	_, _, got, err := Parse(padded(t, `{"topic":"algebra","text":"a","options":["x","X"," x"]}`), crit)
	if err != nil || len(got) != 3 {
		t.Fatalf("%v %v", got, err)
	}
}

func TestAddKeepsOptionsInOrderAndOutOfTheCallersReach(t *testing.T) {
	b := New()
	opts := []string{"z", "a", "m"}
	if err := b.Add(Question{Passkey: []byte{1}, Topic: "algebra", Text: "mcq", Options: opts, Hash: [32]byte{1}}); err != nil {
		t.Fatal(err)
	}
	if err := b.Add(Question{Passkey: []byte{1}, Topic: "algebra", Text: "written", Hash: [32]byte{2}}); err != nil {
		t.Fatal(err)
	}
	opts[0] = "changed"
	got := b.Close()
	if !slices.Equal(got[0].Options, []string{"z", "a", "m"}) || got[1].Options != nil {
		t.Fatalf("options %v / %v", got[0].Options, got[1].Options)
	}
}

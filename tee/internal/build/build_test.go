package build

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"testing"

	"paperseal/tee/internal/bank"
	"paperseal/tee/internal/criteria"
	"paperseal/tee/internal/hashing"
	"paperseal/tee/internal/spec"
)

var crit = criteria.Criteria{
	MaxSetterPercent: 100, MinBankMultiple: 2,
	Topics: []criteria.Topic{{Name: "algebra", Questions: 3}, {Name: "geometry", Questions: 2}},
}

func questions() []bank.Question {
	var qs []bank.Question
	for _, topic := range []string{"algebra", "geometry"} {
		for i := 0; i < 10; i++ {
			q := bank.Question{Passkey: []byte{1}, Topic: topic, Text: fmt.Sprintf("%s question %d with <html> & text", topic, i)}
			q.Hash[0], q.Hash[1] = byte(len(topic)), byte(i)
			qs = append(qs, q)
		}
	}
	return qs
}

func TestSelect(t *testing.T) {
	var seed [32]byte
	seed[0] = 7
	a, err := Select(seed, crit, questions())
	if err != nil {
		t.Fatal(err)
	}
	if len(a) != 5 {
		t.Fatalf("selected %d", len(a))
	}
	counts := map[string]int{}
	seen := map[string]bool{}
	for _, q := range a {
		counts[q.Topic]++
		if seen[q.Text] {
			t.Fatalf("repeated question %q", q.Text)
		}
		seen[q.Text] = true
	}
	if counts["algebra"] != 3 || counts["geometry"] != 2 {
		t.Fatalf("counts %v", counts)
	}
	// Topics come in criteria order.
	if a[0].Topic != "algebra" || a[3].Topic != "geometry" {
		t.Fatalf("order %v", a)
	}
	// The same seed repeats the draw whatever the arrival order.
	rev := questions()
	for i, j := 0, len(rev)-1; i < j; i, j = i+1, j-1 {
		rev[i], rev[j] = rev[j], rev[i]
	}
	b, _ := Select(seed, crit, rev)
	for i := range a {
		if a[i].Text != b[i].Text {
			t.Fatal("selection depends on arrival order")
		}
	}
	// Another seed makes another draw.
	differs := false
	for s := byte(1); s < 20 && !differs; s++ {
		seed[0] = s
		c, _ := Select(seed, crit, questions())
		for i := range a {
			if a[i].Text != c[i].Text {
				differs = true
			}
		}
	}
	if !differs {
		t.Fatal("selection ignores the seed")
	}
	// Too few questions.
	if _, err := Select(seed, crit, questions()[:11]); err == nil {
		t.Fatal("selected from a short bank")
	}
}

func TestBuildProducesTheCommittedPaper(t *testing.T) {
	var exam [32]byte
	exam[0] = 9
	p, err := Build(exam, crit, questions())
	if err != nil {
		t.Fatal(err)
	}
	if p.Selected != 5 || p.BankSize != 20 {
		t.Fatalf("selected %d of %d", p.Selected, p.BankSize)
	}
	if len(p.K) != 32 || p.Seed == ([32]byte{}) {
		t.Fatal("key or seed missing")
	}
	// The file is nonce + (seed + padded paper) + tag.
	if want := 12 + 32 + spec.C.Padding.PaperBytes + 16; len(p.EncryptedPaper) != want {
		t.Fatalf("file is %d bytes, want %d", len(p.EncryptedPaper), want)
	}
	seed, paper, err := OpenPaper(p.K, exam, p.EncryptedPaper)
	if err != nil {
		t.Fatal(err)
	}
	if seed != p.Seed || !bytes.Equal(paper, p.PaperJSON) {
		t.Fatal("paper does not open to what was built")
	}
	var doc PaperDoc
	if err := json.Unmarshal(paper, &doc); err != nil || len(doc.Questions) != 5 || doc.ExamID != "0x0900000000000000000000000000000000000000000000000000000000000000" {
		t.Fatalf("paper JSON: %s %v", paper, err)
	}
	if bytes.Contains(paper, []byte("\\u003c")) {
		t.Fatal("HTML characters were escaped")
	}
	// The salted hash is what a centre recomputes.
	m, err := hashing.SaltedPaper(seed, paper)
	if err != nil || m.Sum() != p.SaltedPaperHash {
		t.Fatal("salted paper hash differs")
	}
	// A wrong key or exam doesn't open it.
	if _, _, err := OpenPaper(p.K, [32]byte{}, p.EncryptedPaper); err == nil {
		t.Fatal("opened under another exam")
	}
	// Two builds differ, because seed and key are fresh.
	q, _ := Build(exam, crit, questions())
	if q.Seed == p.Seed || bytes.Equal(q.K, p.K) {
		t.Fatal("seed or key repeated")
	}
}

// Lock reasons about the paper's size from the entries, so they must add up to
// the paper Build writes.
func TestEntrySizesAddUpToThePaper(t *testing.T) {
	qs := questions()
	qs[0].Text = "tab\t quote\" slash\\ line\u2028 \u00e9 <&>"
	qs[1].Options = []string{"<a>", "b & c\u2029", "d\n"}
	p, err := Build([32]byte{9}, crit, qs)
	if err != nil {
		t.Fatal(err)
	}
	var doc PaperDoc
	if err := json.Unmarshal(p.PaperJSON, &doc); err != nil {
		t.Fatal(err)
	}
	var sizes []int
	for _, q := range doc.Questions {
		n, err := EntrySize(bank.Question{Topic: q.Topic, Text: q.Text, Options: q.Options})
		if err != nil {
			t.Fatal(err)
		}
		sizes = append(sizes, n)
	}
	got, err := MaxPaperJSONBytes(sizes)
	if err != nil || got != len(p.PaperJSON) {
		t.Fatalf("entries add up to %d, the paper is %d: %v", got, len(p.PaperJSON), err)
	}
}

func TestPaperWipeZeroesWhatMustNotOutliveTheBuild(t *testing.T) {
	p, err := Build([32]byte{9}, crit, questions())
	if err != nil {
		t.Fatal(err)
	}
	k, doc, enc := p.K, p.PaperJSON, p.EncryptedPaper
	if bytes.Equal(p.Seed[:], make([]byte, 32)) {
		t.Fatal("setup: no seed")
	}
	p.Wipe()
	for name, b := range map[string][]byte{"K": k, "seed": p.Seed[:], "paper JSON": doc} {
		if !bytes.Equal(b, make([]byte, len(b))) {
			t.Errorf("%s left in memory", name)
		}
	}
	if bytes.Equal(enc, make([]byte, len(enc))) {
		t.Error("the published encrypted paper was wiped")
	}
}

// want is what JSON.stringify gives for the same value, checked with node. The
// characters Go's encoder would write differently are U+2028 and U+2029, so
// they are spelled out in the Go source and sit raw in the bytes.
func TestPaperBytesEqualJSONStringify(t *testing.T) {
	doc := PaperDoc{
		ExamID: "0x0900000000000000000000000000000000000000000000000000000000000000",
		Questions: []PaperQuestion{
			{Topic: "algebra", Text: "a\u2028b\u2029 <&> \"q\" \\ \b\f\n\r\t\x01\x1f \x7f \u00e9 \U0001F600",
				Options: []string{"<x>", "A & B", "\u2028", `\u2028`}},
			{Topic: "geometry", Text: "w"},
		},
	}
	want := `{"examId":"0x0900000000000000000000000000000000000000000000000000000000000000","questions":[` +
		`{"topic":"algebra","text":"a` + "\u2028" + `b` + "\u2029" + ` <&> \"q\" \\ \b\f\n\r\t\u0001\u001f ` + "\x7f" + ` é ` + "\U0001F600" + `",` +
		`"options":["<x>","A & B","` + "\u2028" + `","\\u2028"]},` +
		`{"topic":"geometry","text":"w"}]}`
	got, err := encodeDoc(doc)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != want {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
	// It is still valid JSON that reads back to the same value.
	var back PaperDoc
	if err := json.Unmarshal(got, &back); err != nil || !reflect.DeepEqual(back, doc) {
		t.Fatalf("round trip: %v", err)
	}
}

func TestMultipleChoiceReachesThePaperInTheSettersOrder(t *testing.T) {
	qs := questions()
	opts := []string{"zeta", "alpha", "<mid>", "beta"}
	for i := range qs {
		if qs[i].Topic == "algebra" {
			qs[i].Options = slices.Clone(opts) // Every algebra question is multiple choice.
		}
	}
	p, err := Build([32]byte{9}, crit, qs)
	if err != nil {
		t.Fatal(err)
	}
	var doc PaperDoc
	if err := json.Unmarshal(p.PaperJSON, &doc); err != nil {
		t.Fatal(err)
	}
	for _, q := range doc.Questions {
		switch q.Topic {
		case "algebra":
			if !slices.Equal(q.Options, opts) {
				t.Errorf("options %v", q.Options)
			}
		default:
			if q.Options != nil {
				t.Errorf("written question has options %v", q.Options)
			}
		}
	}
	// Keys are topic, text, options in that order, and a written question has no options key.
	var raw struct {
		Questions []json.RawMessage `json:"questions"`
	}
	if err := json.Unmarshal(p.PaperJSON, &raw); err != nil {
		t.Fatal(err)
	}
	for i, r := range raw.Questions {
		dec := json.NewDecoder(bytes.NewReader(r))
		var keys []string
		dec.Token() // {
		for dec.More() {
			k, _ := dec.Token()
			keys = append(keys, k.(string))
			var skip json.RawMessage
			if err := dec.Decode(&skip); err != nil {
				t.Fatal(err)
			}
		}
		want := []string{"topic", "text"}
		if doc.Questions[i].Topic == "algebra" {
			want = append(want, "options")
		}
		if !slices.Equal(keys, want) {
			t.Errorf("question %d keys %v, want %v", i, keys, want)
		}
	}
	// Selection keeps options with their question.
	var seed [32]byte
	picked, err := Select(seed, crit, qs)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range picked {
		if (q.Topic == "algebra") != slices.Equal(q.Options, opts) {
			t.Errorf("selected %s with options %v", q.Topic, q.Options)
		}
	}
}

func TestWrittenPaperHasNoOptionsKey(t *testing.T) {
	p, err := Build([32]byte{9}, crit, questions())
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(p.PaperJSON, []byte("options")) {
		t.Fatalf("written paper mentions options: %s", p.PaperJSON)
	}
}

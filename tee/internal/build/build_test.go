package build

import (
	"bytes"
	"encoding/json"
	"fmt"
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
		n, err := EntrySize(bank.Question{Topic: q.Topic, Text: q.Text})
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

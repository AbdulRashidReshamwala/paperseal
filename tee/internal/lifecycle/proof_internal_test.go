package lifecycle

import (
	"bytes"
	"fmt"
	"testing"

	"paperseal/tee/internal/bank"
	"paperseal/tee/internal/build"
	"paperseal/tee/internal/criteria"
	"paperseal/tee/internal/split"
)

func splitFixture(t *testing.T) (paper build.Paper, kPub []byte, shares [][]byte, exam [32]byte) {
	t.Helper()
	exam[0] = 4
	c := criteria.Criteria{MaxSetterPercent: 100, MinBankMultiple: 2, Topics: []criteria.Topic{{Name: "a", Questions: 2}}}
	var qs []bank.Question
	for i := range 6 {
		qs = append(qs, bank.Question{Passkey: []byte{1}, Topic: "a", Text: fmt.Sprint("question ", i), Hash: [32]byte{byte(i)}})
	}
	paper, err := build.Build(exam, c, qs)
	if err != nil {
		t.Fatal(err)
	}
	kPub, kPriv, err := split.SplitKey(paper.K)
	if err != nil {
		t.Fatal(err)
	}
	if shares, err = split.SplitShares(kPriv); err != nil {
		t.Fatal(err)
	}
	return paper, kPub, shares, exam
}

func TestProveSplit(t *testing.T) {
	paper, kPub, shares, exam := splitFixture(t)
	if err := proveSplit(exam, &paper, kPub, shares); err != nil {
		t.Fatalf("a good split: %v", err)
	}
	// Proving wipes only its own copies.
	if bytes.Equal(paper.K, make([]byte, 32)) || bytes.Equal(shares[0], make([]byte, len(shares[0]))) {
		t.Fatal("proveSplit wiped the caller's secrets")
	}

	bad := map[string]func(p *build.Paper, kPub []byte, shares [][]byte) [][]byte{
		"a share is wrong": func(_ *build.Paper, _ []byte, s [][]byte) [][]byte {
			s[len(s)-1][0] ^= 1
			return s
		},
		"the first share is wrong": func(_ *build.Paper, _ []byte, s [][]byte) [][]byte {
			s[0][0] ^= 1
			return s
		},
		"K_pub is wrong": func(_ *build.Paper, k []byte, s [][]byte) [][]byte { k[0] ^= 1; return s },
		"K is not what was split": func(p *build.Paper, _ []byte, s [][]byte) [][]byte {
			p.K = bytes.Repeat([]byte{7}, 32)
			return s
		},
		"the paper file is damaged": func(p *build.Paper, _ []byte, s [][]byte) [][]byte {
			p.EncryptedPaper = bytes.Clone(p.EncryptedPaper)
			p.EncryptedPaper[40] ^= 1
			return s
		},
		"the seed differs": func(p *build.Paper, _ []byte, s [][]byte) [][]byte { p.Seed[0] ^= 1; return s },
		"the paper differs": func(p *build.Paper, _ []byte, s [][]byte) [][]byte {
			p.PaperJSON = bytes.Clone(p.PaperJSON)
			p.PaperJSON[3] ^= 1
			return s
		},
		"too few shares": func(_ *build.Paper, _ []byte, s [][]byte) [][]byte { return s[:7] },
	}
	for name, mutate := range bad {
		t.Run(name, func(t *testing.T) {
			p, kPub, shares, exam := splitFixture(t)
			shares = mutate(&p, kPub, shares)
			if err := proveSplit(exam, &p, kPub, shares); err == nil {
				t.Fatal("a split that can't be opened was accepted")
			}
		})
	}
}

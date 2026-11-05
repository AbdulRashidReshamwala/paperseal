// Package build selects questions and assembles the one encrypted paper.
package build

import (
	"bytes"
	crand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"sort"

	"paperseal/tee/internal/bank"
	"paperseal/tee/internal/criteria"
	"paperseal/tee/internal/encryption"
	"paperseal/tee/internal/hashing"
	"paperseal/tee/internal/spec"
)

// Paper is the output of Build, and supplies its fields of hashing.BuildFields.
// The caller adds the rest once the files are stored, because
// storageManifestHash isn't known here. K and Seed stay in memory only long
// enough to split and to be proven after the exam.
type Paper struct {
	PaperJSON       []byte   // The paper, before padding.
	EncryptedPaper  []byte   // The seed and padded paper, encrypted with K.
	PaperHash       [32]byte // Plain SHA-256 of EncryptedPaper.
	SaltedPaperHash [32]byte // hashing.SaltedPaper over the seed and paper.
	Selected        uint32
	BankSize        uint32
	K               []byte
	Seed            [32]byte
}

// PaperQuestion is a question as the paper carries it.
type PaperQuestion struct {
	Topic string `json:"topic"`
	Text  string `json:"text"`
}

// PaperDoc is the paper's JSON, from spec/api.md "Paper Format".
type PaperDoc struct {
	ExamID    string          `json:"examId"`
	Questions []PaperQuestion `json:"questions"`
}

// Select picks each topic's number of questions at random, using the seed. It
// is deterministic for a seed, so whoever learns the seed after the exam can
// repeat the draw. The bank is sorted first, so arrival order doesn't matter.
// The result lists topics in criteria order.
func Select(seed [32]byte, c criteria.Criteria, questions []bank.Question) ([]bank.Question, error) {
	byTopic := map[string][]bank.Question{}
	for _, q := range questions {
		byTopic[q.Topic] = append(byTopic[q.Topic], q)
	}
	rng := rand.New(rand.NewChaCha8(seed))
	var out []bank.Question
	for _, t := range c.Topics {
		pool := byTopic[t.Name]
		if uint64(len(pool)) < uint64(t.Questions) {
			return nil, fmt.Errorf("build: topic %q has %d questions, needs %d", t.Name, len(pool), t.Questions)
		}
		sort.Slice(pool, func(i, j int) bool { return bytes.Compare(pool[i].Hash[:], pool[j].Hash[:]) < 0 })
		rng.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })
		out = append(out, pool[:t.Questions]...)
	}
	return out, nil
}

// Build runs Build after Lock. It generates the private seed and K itself, so
// the randomness that picks the questions never comes from outside the TEE.
func Build(examID [32]byte, c criteria.Criteria, questions []bank.Question) (Paper, error) {
	return buildFrom(crand.Reader, examID, c, questions)
}

func buildFrom(rnd io.Reader, examID [32]byte, c criteria.Criteria, questions []bank.Question) (Paper, error) {
	selected, err := c.Selected()
	if err != nil {
		return Paper{}, err
	}
	var p Paper
	if _, err := io.ReadFull(rnd, p.Seed[:]); err != nil {
		return Paper{}, fmt.Errorf("build: seed: %w", err)
	}
	p.K = make([]byte, spec.C.Crypto.KeyBytes)
	if _, err := io.ReadFull(rnd, p.K); err != nil {
		return Paper{}, fmt.Errorf("build: key: %w", err)
	}
	picked, err := Select(p.Seed, c, questions)
	if err != nil {
		return Paper{}, err
	}
	doc := PaperDoc{ExamID: "0x" + hex.EncodeToString(examID[:])}
	for _, q := range picked {
		doc.Questions = append(doc.Questions, PaperQuestion{q.Topic, q.Text})
	}
	if uint32(len(doc.Questions)) != selected {
		return Paper{}, errors.New("build: selected count differs from the criteria")
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(doc); err != nil {
		return Paper{}, err
	}
	p.PaperJSON = bytes.TrimSuffix(buf.Bytes(), []byte("\n"))

	padded, err := encryption.Pad(p.PaperJSON, spec.C.Padding.PaperBytes)
	if err != nil {
		return Paper{}, fmt.Errorf("build: paper: %w", err)
	}
	// The encrypted file is the seed, then the padded paper.
	if p.EncryptedPaper, err = encryption.SealAESFrom(rnd, p.K, examID, append(append([]byte(nil), p.Seed[:]...), padded...)); err != nil {
		return Paper{}, err
	}
	p.PaperHash = sha256Sum(p.EncryptedPaper)
	salted, err := hashing.SaltedPaper(p.Seed, p.PaperJSON)
	if err != nil {
		return Paper{}, err
	}
	p.SaltedPaperHash = salted.Sum()
	p.Selected = selected
	p.BankSize = uint32(len(questions))
	return p, nil
}

// OpenPaper reverses the paper file: it returns the seed and the paper JSON.
// Centres and the verifier page do the same in TypeScript. The TEE uses it in
// tests, and to prove the file opens before anything is stored.
func OpenPaper(k []byte, examID [32]byte, file []byte) (seed [32]byte, paper []byte, err error) {
	plain, err := encryption.OpenAES(k, examID, file)
	if err != nil {
		return seed, nil, err
	}
	if len(plain) != 32+spec.C.Padding.PaperBytes {
		return seed, nil, errors.New("build: paper file has the wrong size")
	}
	copy(seed[:], plain[:32])
	paper, err = encryption.Unpad(plain[32:], spec.C.Padding.PaperBytes)
	return seed, paper, err
}

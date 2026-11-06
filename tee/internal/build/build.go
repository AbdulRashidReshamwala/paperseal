// Package build selects questions and assembles the one encrypted paper.
package build

import (
	"bytes"
	crand "crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"slices"
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
	Topic   string   `json:"topic"`
	Text    string   `json:"text"`
	Options []string `json:"options,omitempty"` // The setter's order. Absent for a written question.
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

// encodeDoc is the paper's JSON, written the one way Build and EntrySize share.
// The bytes equal what JSON.stringify gives for the same value, because the
// TypeScript side re-encodes papers that way and saltedPaperHash covers the
// bytes. encoding/json differs even with HTML escaping off: it writes U+2028
// and U+2029 as \u2028 and \u2029, which JSON.stringify leaves as they are.
// So strings are written by jsonString and the encoder is not used. A question is topic, text, then options when it has any.
func encodeDoc(doc PaperDoc) ([]byte, error) {
	b := []byte(`{"examId":`)
	b = jsonString(b, doc.ExamID)
	b = append(b, `,"questions":[`...)
	for i, q := range doc.Questions {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, `{"topic":`...)
		b = jsonString(b, q.Topic)
		b = append(b, `,"text":`...)
		b = jsonString(b, q.Text)
		if len(q.Options) > 0 {
			b = append(b, `,"options":[`...)
			for j, o := range q.Options {
				if j > 0 {
					b = append(b, ',')
				}
				b = jsonString(b, o)
			}
			b = append(b, ']')
		}
		b = append(b, '}')
	}
	return append(b, `]}`...), nil
}

// jsonString appends s as JSON.stringify writes it: quote, backslash, \b \f
// \n \r \t and the other control characters below U+0020 as lowercase \u00xx
// are escaped, and everything else, including <, >, & and U+2028, is literal.
// s is valid UTF-8, because bank.Parse refuses anything else. Lone surrogates,
// which JSON.stringify escapes, can't occur in UTF-8.
func jsonString(b []byte, s string) []byte {
	const hexDigits = "0123456789abcdef"
	b = append(b, '"')
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c == '"' || c == '\\':
			b = append(b, '\\', c)
		case c == '\b':
			b = append(b, '\\', 'b')
		case c == '\f':
			b = append(b, '\\', 'f')
		case c == '\n':
			b = append(b, '\\', 'n')
		case c == '\r':
			b = append(b, '\\', 'r')
		case c == '\t':
			b = append(b, '\\', 't')
		case c < 0x20:
			b = append(b, '\\', 'u', '0', '0', hexDigits[c>>4], hexDigits[c&15])
		default:
			b = append(b, c)
		}
	}
	return append(b, '"')
}

// EncodeDoc returns the paper's JSON, the bytes saltedPaperHash covers, for
// vectors and for readers that must reproduce them.
func EncodeDoc(doc PaperDoc) ([]byte, error) { return encodeDoc(doc) }

// MaxPaperJSONBytes is the most the paper's JSON can take when it holds
// questions of the given encoded sizes: the envelope, then each question's
// entry and the commas between them. A question's size in the paper can differ
// from the bytes it was sent in, because the paper escapes some characters, so
// Lock uses this to refuse a bank whose worst draw wouldn't fit.
func MaxPaperJSONBytes(entrySizes []int) (int, error) {
	empty, err := encodeDoc(PaperDoc{ExamID: "0x" + hex.EncodeToString(make([]byte, 32)), Questions: []PaperQuestion{}})
	if err != nil {
		return 0, err
	}
	total := len(empty)
	for i, n := range entrySizes {
		total += n
		if i > 0 {
			total++ // The comma.
		}
	}
	return total, nil
}

// EntrySize is how many bytes a question takes in the paper's JSON.
func EntrySize(q bank.Question) (int, error) {
	b, err := encodeDoc(PaperDoc{Questions: []PaperQuestion{{q.Topic, q.Text, q.Options}}})
	if err != nil {
		return 0, err
	}
	empty, err := encodeDoc(PaperDoc{Questions: []PaperQuestion{}})
	if err != nil {
		return 0, err
	}
	return len(b) - len(empty), nil
}

// Wipe zeroes what Build made that must not outlive the build: K, the seed
// and the paper's plaintext JSON. The encrypted paper and its hashes are
// published and stay.
func (p *Paper) Wipe() {
	clear(p.K)
	clear(p.Seed[:])
	clear(p.PaperJSON)
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
		doc.Questions = append(doc.Questions, PaperQuestion{q.Topic, q.Text, slices.Clone(q.Options)})
	}
	if uint32(len(doc.Questions)) != selected {
		return Paper{}, errors.New("build: selected count differs from the criteria")
	}
	if p.PaperJSON, err = encodeDoc(doc); err != nil {
		return Paper{}, err
	}

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

// Package bank holds the decrypted question bank in memory. Questions arrive
// encrypted, and the TEE opens them, so the bank is the only place the
// plaintext lives until Build.
package bank

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"unicode/utf8"

	"paperseal/tee/internal/criteria"
	"paperseal/tee/internal/encryption"
	"paperseal/tee/internal/spec"
)

// MaxQuestions bounds the bank, because it lives in memory and anyone on the
// list can submit. The spec sets no limit, so this is a generous default.
const MaxQuestions = 100000

// Errors Add and Parse return.
var (
	ErrClosed       = errors.New("bank: closed, the lock round has passed")
	ErrDuplicate    = errors.New("bank: duplicate question")
	ErrFull         = errors.New("bank: full")
	ErrFormat       = errors.New("bank: question is not the expected format")
	ErrUnknownTopic = errors.New("bank: topic is not in the criteria")
)

// Question is one accepted question.
type Question struct {
	Passkey []byte   // The setter's passkey public key.
	Topic   string   // A criteria topic.
	Text    string   // Non-empty.
	Hash    [32]byte // Plain SHA-256 of the ciphertext, the questionHash.
}

// wire is the JSON of a question, from spec/api.md "Paper Format".
type wire struct {
	Topic *string `json:"topic"`
	Text  *string `json:"text"`
}

// Parse removes the padding from a decrypted question and checks its format:
// exactly {"topic": string, "text": string}, with a topic from the criteria and
// non-empty text.
func Parse(padded []byte, c criteria.Criteria) (topic, text string, err error) {
	raw, err := encryption.Unpad(padded, spec.C.Padding.QuestionBytes)
	if err != nil {
		return "", "", fmt.Errorf("%w: %v", ErrFormat, err)
	}
	// encoding/json turns invalid UTF-8 into U+FFFD, so check the bytes first.
	if !utf8.Valid(raw) {
		return "", "", fmt.Errorf("%w: not UTF-8", ErrFormat)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var w wire
	if err := dec.Decode(&w); err != nil {
		return "", "", fmt.Errorf("%w: %v", ErrFormat, err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return "", "", fmt.Errorf("%w: trailing data", ErrFormat)
	}
	if w.Topic == nil || w.Text == nil {
		return "", "", fmt.Errorf("%w: topic and text are required", ErrFormat)
	}
	if strings.TrimSpace(*w.Text) == "" {
		return "", "", fmt.Errorf("%w: text is empty", ErrFormat)
	}
	for _, t := range c.Topics {
		if t.Name == *w.Topic {
			return *w.Topic, *w.Text, nil
		}
	}
	return "", "", fmt.Errorf("%w: %q", ErrUnknownTopic, *w.Topic)
}

// Bank holds accepted questions until Lock.
type Bank struct {
	mu     sync.Mutex
	closed bool
	seen   map[[32]byte]bool // Normalised question text, and ciphertext hashes.
	list   []Question
}

// New returns an empty bank.
func New() *Bank { return &Bank{seen: map[[32]byte]bool{}} }

func textKey(text string) [32]byte {
	return sha256.Sum256([]byte("text\x00" + strings.ToLower(strings.Join(strings.Fields(text), " "))))
}

func hashKey(h [32]byte) [32]byte { return sha256.Sum256(append([]byte("ct\x00"), h[:]...)) }

// Add keeps a question. It refuses one whose ciphertext was seen, and one
// whose text matches another question, ignoring case and spacing, whoever sent
// it, so one idea can't fill a topic's quota twice.
func (b *Bank) Add(q Question) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return ErrClosed
	}
	if len(b.list) >= MaxQuestions {
		return ErrFull
	}
	tk, hk := textKey(q.Text), hashKey(q.Hash)
	if b.seen[tk] || b.seen[hk] {
		return ErrDuplicate
	}
	b.seen[tk], b.seen[hk] = true, true
	b.list = append(b.list, Question{
		Passkey: bytes.Clone(q.Passkey), Topic: q.Topic, Text: q.Text, Hash: q.Hash,
	})
	return nil
}

// Close stops submissions and returns the bank, in arrival order. It can be
// called again and returns the same questions.
func (b *Bank) Close() []Question {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	return append([]Question(nil), b.list...)
}

// Count returns how many questions are held.
func (b *Bank) Count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.list)
}

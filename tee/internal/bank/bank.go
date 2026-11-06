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
	"slices"
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
	Options []string // The choices in the setter's order, or nil for a written question.
	Hash    [32]byte // Plain SHA-256 of the ciphertext, the questionHash.
}

// wire is the JSON of a question, from spec/api.md "Paper Format".
type wire struct {
	Topic *string `json:"topic"`
	Text  *string `json:"text"`
	// Options is a RawMessage so an explicit null can be told from a missing key.
	Options json.RawMessage `json:"options"`
}

// Parse removes the padding from a decrypted question and checks its format:
// exactly {"topic": string, "text": string} with an optional "options" list of
// strings, a topic from the criteria and non-empty text. options is nil for a
// written question. A multiple choice question has between
// limits.questionOptionsMin and questionOptionsMax options, none blank after
// trimming and no two equal. The options keep the setter's order.
func Parse(padded []byte, c criteria.Criteria) (topic, text string, options []string, err error) {
	raw, err := encryption.Unpad(padded, spec.C.Padding.QuestionBytes)
	if err != nil {
		return "", "", nil, fmt.Errorf("%w: %v", ErrFormat, err)
	}
	// encoding/json turns invalid UTF-8 into U+FFFD, so check the bytes first.
	if !utf8.Valid(raw) {
		return "", "", nil, fmt.Errorf("%w: not UTF-8", ErrFormat)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var w wire
	if err := dec.Decode(&w); err != nil {
		return "", "", nil, fmt.Errorf("%w: %v", ErrFormat, err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return "", "", nil, fmt.Errorf("%w: trailing data", ErrFormat)
	}
	if w.Topic == nil || w.Text == nil {
		return "", "", nil, fmt.Errorf("%w: topic and text are required", ErrFormat)
	}
	if strings.TrimSpace(*w.Text) == "" {
		return "", "", nil, fmt.Errorf("%w: text is empty", ErrFormat)
	}
	if w.Options != nil {
		if options, err = parseOptions(w.Options); err != nil {
			return "", "", nil, err
		}
	}
	for _, t := range c.Topics {
		if t.Name == *w.Topic {
			return *w.Topic, *w.Text, options, nil
		}
	}
	return "", "", nil, fmt.Errorf("%w: %q", ErrUnknownTopic, *w.Topic)
}

// parseOptions checks the value of an "options" key that is present.
func parseOptions(raw json.RawMessage) ([]string, error) {
	var list []string
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, fmt.Errorf("%w: options is null, a written question has no options key", ErrFormat)
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("%w: options: %v", ErrFormat, err)
	}
	lim := spec.C.Limits
	if len(list) == 0 {
		return nil, fmt.Errorf("%w: options is empty, a written question has no options key", ErrFormat)
	}
	if len(list) < lim.QuestionOptionsMin || len(list) > lim.QuestionOptionsMax {
		return nil, fmt.Errorf("%w: %d options, need %d to %d", ErrFormat, len(list), lim.QuestionOptionsMin, lim.QuestionOptionsMax)
	}
	seen := make(map[string]bool, len(list))
	for _, o := range list {
		if strings.TrimSpace(o) == "" {
			return nil, fmt.Errorf("%w: an option is blank", ErrFormat)
		}
		if seen[o] {
			return nil, fmt.Errorf("%w: duplicate option", ErrFormat)
		}
		seen[o] = true
	}
	return list, nil
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

// Both keys are per setter. A setter that could see "duplicate" for a question
// someone else sent could test guesses at other setters' questions.
func textKey(passkey []byte, text string) [32]byte {
	h := sha256.New()
	h.Write([]byte("text\x00"))
	h.Write(passkey)
	h.Write([]byte{0})
	h.Write([]byte(strings.ToLower(strings.Join(strings.Fields(text), " "))))
	return [32]byte(h.Sum(nil))
}

func hashKey(passkey []byte, ct [32]byte) [32]byte {
	h := sha256.New()
	h.Write([]byte("ct\x00"))
	h.Write(passkey)
	h.Write([]byte{0})
	h.Write(ct[:])
	return [32]byte(h.Sum(nil))
}

// Add keeps a question. It refuses one whose ciphertext this setter already
// sent, and one whose text matches another question from the same setter,
// ignoring case and spacing, so a setter can't fill a topic's quota with one
// idea. Questions from different setters are never duplicates of each other.
func (b *Bank) Add(q Question) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return ErrClosed
	}
	if len(b.list) >= MaxQuestions {
		return ErrFull
	}
	tk, hk := textKey(q.Passkey, q.Text), hashKey(q.Passkey, q.Hash)
	if b.seen[tk] || b.seen[hk] {
		return ErrDuplicate
	}
	b.seen[tk], b.seen[hk] = true, true
	b.list = append(b.list, Question{
		Passkey: bytes.Clone(q.Passkey), Topic: q.Topic, Text: q.Text, Options: slices.Clone(q.Options), Hash: q.Hash,
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

// Wipe drops every question and the duplicate index, and zeroes what it can.
// It closes the bank, so nothing more is accepted. Build calls it once the
// paper is made, so the questions it didn't select don't stay in memory and
// stay secret. The text of a question is a Go string, which can't be zeroed in
// place: Wipe overwrites each entry and drops every reference, so the strings
// are garbage and no longer reachable from the bank.
func (b *Bank) Wipe() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	for i := range b.list {
		clear(b.list[i].Passkey)
		b.list[i] = Question{}
	}
	b.list = nil
	clear(b.seen)
}

// Count returns how many questions are held.
func (b *Bank) Count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.list)
}

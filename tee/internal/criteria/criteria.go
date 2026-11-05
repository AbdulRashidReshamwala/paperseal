// Package criteria encodes and decodes the `criteria` bytes in spec/api.md
// "Selection Criteria", which are abi.encode(Criteria). The contract doesn't
// decode them, so Decode is where their rules are enforced, and it accepts one
// encoding only. go-ethereum reads and writes the bytes.
package criteria

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"unicode/utf8"

	"github.com/ethereum/go-ethereum/accounts/abi"
)

// Reasons Decode refuses criteria. Wrapped errors add where and why.
var (
	ErrMalformed        = errors.New("criteria: not a valid abi.encode(Criteria)")
	ErrNonCanonical     = errors.New("criteria: bytes differ from the canonical encoding")
	ErrMaxSetterPercent = errors.New("criteria: maxSetterPercent must be from 1 to 100")
	ErrMinBankMultiple  = errors.New("criteria: minBankMultiple must be at least 2")
	ErrNoTopics         = errors.New("criteria: topics is empty")
	ErrTopicName        = errors.New("criteria: topic name must be non-empty UTF-8")
	ErrRepeatedTopic    = errors.New("criteria: repeated topic name")
	ErrTopicQuestions   = errors.New("criteria: topic questions must be at least 1")
	ErrSelectedOverflow = errors.New("criteria: questions sum exceeds uint32")
)

// Topic is one topic of the paper.
type Topic struct {
	Name      string `json:"name"`
	Questions uint32 `json:"questions"` // Taken from this topic, at least 1.
}

// Criteria is the published selection rule.
type Criteria struct {
	MaxSetterPercent uint32  `json:"maxSetterPercent"` // The most of a topic's bank one setter can hold.
	MinBankMultiple  uint32  `json:"minBankMultiple"`  // How many times larger than its questions a topic's bank must be.
	Topics           []Topic `json:"topics"`
}

// args is the ABI shape of `criteria`: one Criteria argument.
var args = func() abi.Arguments {
	t, err := abi.NewType("tuple", "", []abi.ArgumentMarshaling{
		{Name: "maxSetterPercent", Type: "uint32"},
		{Name: "minBankMultiple", Type: "uint32"},
		{Name: "topics", Type: "tuple[]", Components: []abi.ArgumentMarshaling{
			{Name: "name", Type: "string"},
			{Name: "questions", Type: "uint32"},
		}},
	})
	if err != nil {
		panic("criteria: " + err.Error())
	}
	return abi.Arguments{{Type: t}}
}()

// Selected returns the paper's `selected` count, the sum of questions. Build
// carries it as a uint32, so a larger sum is an error.
func (c Criteria) Selected() (uint32, error) {
	var sum uint64
	for _, t := range c.Topics {
		sum += uint64(t.Questions)
	}
	if sum > math.MaxUint32 {
		return 0, ErrSelectedOverflow
	}
	return uint32(sum), nil
}

func (c Criteria) check() error {
	if c.MaxSetterPercent < 1 || c.MaxSetterPercent > 100 {
		return fmt.Errorf("%w, got %d", ErrMaxSetterPercent, c.MaxSetterPercent)
	}
	if c.MinBankMultiple < 2 {
		return fmt.Errorf("%w, got %d", ErrMinBankMultiple, c.MinBankMultiple)
	}
	if len(c.Topics) == 0 {
		return ErrNoTopics
	}
	seen := make(map[string]bool, len(c.Topics))
	for i, t := range c.Topics {
		if t.Name == "" || !utf8.ValidString(t.Name) {
			return fmt.Errorf("topic %d: %w", i, ErrTopicName)
		}
		if seen[t.Name] {
			return fmt.Errorf("topic %d: %w", i, ErrRepeatedTopic)
		}
		seen[t.Name] = true
		if t.Questions < 1 {
			return fmt.Errorf("topic %d: %w", i, ErrTopicQuestions)
		}
	}
	_, err := c.Selected()
	return err
}

// Encode writes valid criteria.
func Encode(c Criteria) ([]byte, error) {
	if err := c.check(); err != nil {
		return nil, err
	}
	return args.Pack(c)
}

// Decode parses criteria and applies every rule in the spec. ABI decoding
// tolerates trailing bytes, gaps, shared offsets and dirty padding, so it
// re-encodes what it read and refuses any difference: one set of criteria has
// one encoding. The caller checks the hash against the attested criteriaHash.
func Decode(b []byte) (Criteria, error) {
	values, err := args.Unpack(b)
	if err != nil {
		return Criteria{}, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	// The library copies one argument into the first field of a struct.
	var out struct{ Criteria Criteria }
	if err := args.Copy(&out, values); err != nil {
		return Criteria{}, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	again, err := args.Pack(out.Criteria)
	if err != nil {
		return Criteria{}, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	if !bytes.Equal(again, b) {
		return Criteria{}, ErrNonCanonical
	}
	if err := out.Criteria.check(); err != nil {
		return Criteria{}, err
	}
	return out.Criteria, nil
}

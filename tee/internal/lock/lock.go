// Package lock checks the bank against the selection criteria. A bank that
// fails can't go ahead, so the exam can't either.
package lock

import (
	"errors"
	"fmt"

	"paperseal/tee/internal/bank"
	"paperseal/tee/internal/criteria"
)

// Reasons the bank fails.
var (
	ErrBankTooSmall = errors.New("lock: a topic's bank is smaller than minBankMultiple times its questions")
	ErrSetterShare  = errors.New("lock: one setter holds more of a topic than maxSetterPercent")
	ErrEmpty        = errors.New("lock: the bank is empty")
)

// Result is the outcome of the checks. It stays inside the TEE: Lock posts
// nothing on-chain, and the bank size first appears in the Build.
type Result struct {
	QuestionCount uint32
	// PerTopic is how many questions each criteria topic holds.
	PerTopic map[string]int
}

// Check applies the criteria to the bank. For each topic, the bank holds at
// least minBankMultiple times the topic's questions, and no setter holds more
// than maxSetterPercent of the topic's bank. The criteria must already match
// the attested criteriaHash.
func Check(questions []bank.Question, c criteria.Criteria) (Result, error) {
	if len(questions) == 0 {
		return Result{}, ErrEmpty
	}
	perTopic := map[string]int{}
	perSetter := map[string]map[string]int{} // topic -> setter -> count
	for _, q := range questions {
		perTopic[q.Topic]++
		if perSetter[q.Topic] == nil {
			perSetter[q.Topic] = map[string]int{}
		}
		perSetter[q.Topic][string(q.Passkey)]++
	}
	for _, t := range c.Topics {
		n := uint64(perTopic[t.Name])
		if need := uint64(t.Questions) * uint64(c.MinBankMultiple); n < need {
			return Result{}, fmt.Errorf("%w: topic %q has %d, needs %d", ErrBankTooSmall, t.Name, n, need)
		}
		for _, count := range perSetter[t.Name] {
			// count/n <= maxSetterPercent/100, without division.
			if uint64(count)*100 > uint64(c.MaxSetterPercent)*n {
				return Result{}, fmt.Errorf("%w: topic %q, %d of %d with a limit of %d%%",
					ErrSetterShare, t.Name, count, n, c.MaxSetterPercent)
			}
		}
	}
	return Result{QuestionCount: uint32(len(questions)), PerTopic: perTopic}, nil
}

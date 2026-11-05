package lock

import (
	"errors"
	"fmt"
	"testing"

	"paperseal/tee/internal/bank"
	"paperseal/tee/internal/criteria"
)

var crit = criteria.Criteria{
	MaxSetterPercent: 25, MinBankMultiple: 3,
	Topics: []criteria.Topic{{Name: "a", Questions: 2}, {Name: "b", Questions: 1}},
}

// fill adds counts[setter] questions to a topic.
func fill(qs []bank.Question, topic string, counts ...int) []bank.Question {
	for setter, n := range counts {
		for i := 0; i < n; i++ {
			qs = append(qs, bank.Question{Passkey: []byte{byte(setter)}, Topic: topic, Text: fmt.Sprint(topic, setter, i)})
		}
	}
	return qs
}

// ones gives n setters one question each in a topic.
func ones(qs []bank.Question, topic string, n int) []bank.Question {
	counts := make([]int, n)
	for i := range counts {
		counts[i] = 1
	}
	return fill(qs, topic, counts...)
}

func TestCheck(t *testing.T) {
	// Topic a needs 6 and b needs 3. Eight setters hold one each.
	qs := ones(ones(nil, "a", 8), "b", 8)
	res, err := Check(qs, crit)
	if err != nil || res.QuestionCount != 16 || res.PerTopic["a"] != 8 {
		t.Fatalf("good bank: %+v %v", res, err)
	}
}

func TestBankSize(t *testing.T) {
	// Exactly the minimum passes: a has 6, b has 3, each from many setters.
	exact := ones(ones(nil, "a", 6), "b", 3)
	crit100 := crit
	crit100.MaxSetterPercent = 100
	if _, err := Check(exact, crit100); err != nil {
		t.Fatalf("exact minimum: %v", err)
	}
	// One short fails.
	short := ones(ones(nil, "a", 5), "b", 3)
	if _, err := Check(short, crit100); !errors.Is(err, ErrBankTooSmall) {
		t.Fatalf("a one short: %v", err)
	}
	// A topic with no questions at all.
	if _, err := Check(ones(nil, "a", 8), crit100); !errors.Is(err, ErrBankTooSmall) {
		t.Fatalf("empty topic b: %v", err)
	}
}

func TestSetterShare(t *testing.T) {
	// Topic a has 8, and setter 0 holds 3 of them: 37.5% against a limit of 25%.
	qs := ones(fill(nil, "a", 3, 1, 1, 1, 1, 1), "b", 6)
	if _, err := Check(qs, crit); !errors.Is(err, ErrSetterShare) {
		t.Fatalf("got %v", err)
	}
	// Exactly at the limit passes: 2 of 8 is 25%.
	qs = ones(fill(nil, "a", 2, 2, 2, 2), "b", 6)
	if _, err := Check(qs, crit); err != nil {
		t.Fatalf("at the limit: %v", err)
	}
	// The share is per topic: a setter's other topics don't count.
	qs = ones(ones(nil, "a", 8), "b", 8)
	qs = fill(qs, "b", 0, 0, 0)
	if _, err := Check(qs, crit); err != nil {
		t.Fatalf("setter with questions in another topic: %v", err)
	}
	if _, err := Check(nil, crit); !errors.Is(err, ErrEmpty) {
		t.Fatalf("empty: %v", err)
	}
}

func TestOneSetterAt100Percent(t *testing.T) {
	c := crit
	c.MaxSetterPercent = 100
	qs := fill(fill(nil, "a", 6), "b", 3)
	if _, err := Check(qs, c); err != nil {
		t.Fatalf("100%% limit: %v", err)
	}
}

package challenge

import (
	"bytes"
	"errors"
	"testing"
	"time"
)

func TestIssueStoresNothing(t *testing.T) {
	s := New(nil)
	for range 50000 {
		if _, err := s.Issue(); err != nil {
			t.Fatal(err)
		}
	}
	if n := len(s.spent); n != 0 {
		t.Fatalf("issuing kept %d entries, want none", n)
	}
}

func TestChallengeLength(t *testing.T) {
	c, err := New(nil).Issue()
	if err != nil || len(c) != Size || Size != 72 {
		t.Fatalf("len %d, Size %d, err %v", len(c), Size, err)
	}
}

func TestSingleUseAndExpiry(t *testing.T) {
	now := time.Unix(1000, 0)
	s := New(func() time.Time { return now })
	c, _ := s.Issue()
	other, _ := s.Issue()
	if bytes.Equal(c, other) {
		t.Fatal("challenges repeat")
	}
	if err := s.Consume(c); err != nil {
		t.Fatal(err)
	}
	if err := s.Consume(c); !errors.Is(err, ErrUnknown) {
		t.Fatalf("reuse: %v", err)
	}
	now = now.Add(TTL - time.Second)
	if err := s.Consume(other); err != nil {
		t.Fatalf("just before expiry: %v", err)
	}
	third, _ := s.Issue()
	now = now.Add(TTL)
	if err := s.Consume(third); !errors.Is(err, ErrExpired) {
		t.Fatalf("expiry: %v", err)
	}
	if err := s.Check(third); !errors.Is(err, ErrExpired) {
		t.Fatalf("expired Check: %v", err)
	}
	// An expired challenge is never remembered, and spent ones are dropped
	// once they would have expired.
	fresh, _ := s.Issue()
	if err := s.Consume(fresh); err != nil {
		t.Fatal(err)
	}
	if len(s.spent) != 1 {
		t.Fatalf("spent holds %d, want only the fresh one", len(s.spent))
	}
	if err := s.Consume([]byte("short")); !errors.Is(err, ErrUnknown) {
		t.Fatalf("wrong size: %v", err)
	}
}

func TestCheckDoesNotSpend(t *testing.T) {
	s := New(nil)
	c, _ := s.Issue()
	for range 3 {
		if err := s.Check(c); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Consume(c); err != nil {
		t.Fatal(err)
	}
	if err := s.Check(c); !errors.Is(err, ErrUnknown) {
		t.Fatalf("Check of a spent challenge: %v", err)
	}
}

func TestForgeryIsRefused(t *testing.T) {
	s := New(nil)
	c, _ := s.Issue()
	for i := range c {
		bad := bytes.Clone(c)
		bad[i] ^= 1
		if err := s.Consume(bad); !errors.Is(err, ErrUnknown) {
			t.Fatalf("byte %d changed: %v", i, err)
		}
	}
	if err := s.Consume(append(bytes.Clone(c), 0)); !errors.Is(err, ErrUnknown) {
		t.Fatalf("extended: %v", err)
	}
	if len(s.spent) != 0 {
		t.Fatal("a forgery was remembered")
	}
	if err := s.Consume(c); err != nil {
		t.Fatalf("the genuine challenge still works: %v", err)
	}
}

func TestStoresAreSeparate(t *testing.T) {
	a, b := New(nil), New(nil)
	c, _ := a.Issue()
	if err := b.Consume(c); !errors.Is(err, ErrUnknown) {
		t.Fatalf("a challenge crossed stores: %v", err)
	}
}

func TestSpentSetIsBoundedAndRecovers(t *testing.T) {
	now := time.Unix(0, 0)
	s := New(func() time.Time { return now })
	for range maxSpent {
		c, _ := s.Issue()
		if err := s.Consume(c); err != nil {
			t.Fatal(err)
		}
	}
	c, _ := s.Issue()
	if err := s.Consume(c); !errors.Is(err, ErrBusy) {
		t.Fatalf("want ErrBusy, got %v", err)
	}
	// Failing closed: it can't be replayed once there is room either.
	now = now.Add(TTL / 2)
	if err := s.Consume(c); !errors.Is(err, ErrBusy) {
		t.Fatalf("still full: %v", err)
	}
	now = now.Add(TTL)
	fresh, _ := s.Issue()
	if err := s.Consume(fresh); err != nil {
		t.Fatalf("expired entries should free space: %v", err)
	}
	if len(s.spent) > 1 {
		t.Fatalf("expired entries kept: %d", len(s.spent))
	}
}

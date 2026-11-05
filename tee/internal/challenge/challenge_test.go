package challenge

import (
	"errors"
	"testing"
	"time"
)

func TestSingleUseAndExpiry(t *testing.T) {
	now := time.Unix(1000, 0)
	s := New(func() time.Time { return now })
	c, err := s.Issue()
	if err != nil || len(c) != 32 {
		t.Fatalf("issue: %v", err)
	}
	other, _ := s.Issue()
	if string(c) == string(other) {
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
	if err := s.Consume(third); !errors.Is(err, ErrUnknown) {
		t.Fatalf("expired challenge must not be retried: %v", err)
	}
	if err := s.Consume([]byte("short")); !errors.Is(err, ErrUnknown) {
		t.Fatalf("wrong size: %v", err)
	}
}

func TestStoresAreSeparate(t *testing.T) {
	a, b := New(nil), New(nil)
	c, _ := a.Issue()
	if err := b.Consume(c); !errors.Is(err, ErrUnknown) {
		t.Fatalf("a challenge crossed stores: %v", err)
	}
}

func TestBoundedAndRecovers(t *testing.T) {
	now := time.Unix(0, 0)
	s := New(func() time.Time { return now })
	for i := 0; i < maxOutstanding; i++ {
		if _, err := s.Issue(); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Issue(); !errors.Is(err, ErrBusy) {
		t.Fatalf("want ErrBusy, got %v", err)
	}
	now = now.Add(TTL)
	if _, err := s.Issue(); err != nil {
		t.Fatalf("expired challenges should free space: %v", err)
	}
}

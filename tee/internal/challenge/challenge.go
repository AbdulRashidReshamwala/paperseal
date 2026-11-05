// Package challenge issues the fresh TEE challenges in spec/api.md "Passkey
// Signatures": 32 random bytes, single use, expiring after 5 minutes. Each
// route that takes a challenge has its own Store, so a challenge issued for one
// purpose can't be spent on another.
package challenge

import (
	"crypto/rand"
	"errors"
	"sync"
	"time"
)

// Size is the length of a challenge in bytes.
const Size = 32

// TTL is how long a challenge stays valid.
const TTL = 5 * time.Minute

// maxOutstanding bounds memory, because anyone can ask for a challenge.
const maxOutstanding = 10000

// Errors a caller can map to a response.
var (
	ErrUnknown = errors.New("challenge: unknown or already used")
	ErrExpired = errors.New("challenge: expired")
	ErrBusy    = errors.New("challenge: too many outstanding challenges")
)

// Store holds outstanding challenges in memory.
type Store struct {
	now func() time.Time

	mu      sync.Mutex
	expires map[[Size]byte]time.Time
}

// New returns a Store. A nil now uses the system clock. The clock only expires
// challenges, which are not a security claim about time, so drand isn't needed.
func New(now func() time.Time) *Store {
	if now == nil {
		now = time.Now
	}
	return &Store{now: now, expires: map[[Size]byte]time.Time{}}
}

// Issue returns a new challenge.
func (s *Store) Issue() ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if len(s.expires) >= maxOutstanding {
		for c, at := range s.expires {
			if !now.Before(at) {
				delete(s.expires, c)
			}
		}
		if len(s.expires) >= maxOutstanding {
			return nil, ErrBusy
		}
	}
	var c [Size]byte
	if _, err := rand.Read(c[:]); err != nil {
		return nil, err
	}
	s.expires[c] = now.Add(TTL)
	return c[:], nil
}

// Consume spends a challenge. It is removed whether or not it had expired, so
// it can't be tried again.
func (s *Store) Consume(c []byte) error {
	if len(c) != Size {
		return ErrUnknown
	}
	var key [Size]byte
	copy(key[:], c)
	s.mu.Lock()
	defer s.mu.Unlock()
	at, ok := s.expires[key]
	if !ok {
		return ErrUnknown
	}
	delete(s.expires, key)
	if !s.now().Before(at) {
		return ErrExpired
	}
	return nil
}

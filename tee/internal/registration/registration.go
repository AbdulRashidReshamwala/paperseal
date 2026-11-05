// Package registration holds what the TEE verified at registration. Only the
// instance that ran Onboard has it, and it is checked against the approved list
// once, by approvedlist.CheckRegistered.
package registration

import (
	"bytes"
	"errors"
	"sync"
)

// Errors for Add.
var (
	ErrClosed    = errors.New("registration: closed, the approved list has been read")
	ErrDuplicate = errors.New("registration: passkey or derived key already registered")
)

// Record is one verified registration. DerivedPublicKey is empty for a setter.
// The passkey signed InviteTag, but the TEE can't check it, because it never
// sees the invite secret. Only the board can, from the list.
type Record struct {
	Owner            string
	PasskeyPublicKey []byte
	DerivedPublicKey []byte
	InviteTag        [32]byte
}

// Store keeps verified registrations in memory.
type Store struct {
	mu      sync.Mutex
	closed  bool
	records []Record
}

// Add stores a record that has passed its checks. A passkey or derived key that
// is already registered is refused, so a second registration can't replace the
// first.
func (s *Store) Add(r Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrClosed
	}
	for _, have := range s.records {
		if bytes.Equal(have.PasskeyPublicKey, r.PasskeyPublicKey) ||
			(len(r.DerivedPublicKey) != 0 && bytes.Equal(have.DerivedPublicKey, r.DerivedPublicKey)) {
			return ErrDuplicate
		}
	}
	s.records = append(s.records, Record{
		Owner:            r.Owner,
		PasskeyPublicKey: bytes.Clone(r.PasskeyPublicKey),
		DerivedPublicKey: bytes.Clone(r.DerivedPublicKey),
		InviteTag:        r.InviteTag,
	})
	return nil
}

// Close ends registration. Onboard closes it before reading the list, so no
// registration can arrive after the check.
func (s *Store) Close() {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
}

// Count returns how many registrations are held.
func (s *Store) Count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.records)
}

// Verified implements approvedlist.Registrations.
func (s *Store) Verified(passkeyPublicKey, derivedPublicKey []byte, owner string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.records {
		if r.Owner == owner && bytes.Equal(r.PasskeyPublicKey, passkeyPublicKey) &&
			bytes.Equal(r.DerivedPublicKey, derivedPublicKey) {
			return true
		}
	}
	return false
}

// List returns the verified registrations in the order they were made. The
// records are public data, because the approved list is published anyway.
func (s *Store) List() []Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Record, len(s.records))
	for i, r := range s.records {
		out[i] = Record{r.Owner, bytes.Clone(r.PasskeyPublicKey), bytes.Clone(r.DerivedPublicKey), r.InviteTag}
	}
	return out
}

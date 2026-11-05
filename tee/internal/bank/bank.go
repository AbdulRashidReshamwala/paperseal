// Package bank holds the encrypted question bank.
package bank

import (
	"context"

	"paperseal/tee/internal/notimpl"
)

// Submission is one question as a setter uploads it: padded to
// padding.questionBytes, then encrypted to the instance key with HPKE.
type Submission struct {
	SetterID   string
	Ciphertext []byte
}

// Store validates and keeps submissions until Lock.
type Store interface {
	Add(ctx context.Context, s Submission) error
	All(ctx context.Context) ([]Submission, error)
}

// Memory is the stub Store.
type Memory struct{}

// Add is not implemented.
func (Memory) Add(context.Context, Submission) error { return notimpl.New("bank.Memory.Add") }

// All is not implemented.
func (Memory) All(context.Context) ([]Submission, error) { return nil, notimpl.New("bank.Memory.All") }

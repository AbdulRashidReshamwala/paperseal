// Package lock checks the bank against the selection criteria and fixes it.
package lock

import (
	"context"

	"paperseal/tee/internal/criteria"
	"paperseal/tee/internal/notimpl"
)

// Result is the outcome of the checks. It stays inside the TEE: Lock posts
// nothing on-chain, and the bank size first appears in the Build.
type Result struct {
	QuestionCount uint32
}

// Locker runs the checks at the lock round. Implementations must confirm the
// criteria hash to the attested settings.CriteriaHash before using them.
type Locker interface {
	Lock(ctx context.Context, c criteria.Criteria) (Result, error)
}

// Bank is the stub Locker.
type Bank struct{}

// Lock is not implemented.
func (Bank) Lock(context.Context, criteria.Criteria) (Result, error) {
	return Result{}, notimpl.New("lock.Bank.Lock")
}

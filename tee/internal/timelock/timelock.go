// Package timelock is the drand time seal and the only clock the TEE trusts.
package timelock

import (
	"context"

	"paperseal/tee/internal/notimpl"
)

// Sealer timelocks data to a drand round on quicknet.
type Sealer interface {
	Seal(ctx context.Context, round uint64, plaintext []byte) ([]byte, error)
}

// Beacon reads drand rounds. Implementations must verify each round against
// the public key in spec/constants.json, because the board controls the
// network.
type Beacon interface {
	// Randomness returns a verified round's randomness, or an error if the
	// round is not published yet.
	Randomness(ctx context.Context, round uint64) ([]byte, error)
}

// Drand is the stub Sealer and Beacon.
type Drand struct{}

// Seal is not implemented.
func (Drand) Seal(context.Context, uint64, []byte) ([]byte, error) {
	return nil, notimpl.New("timelock.Drand.Seal")
}

// Randomness is not implemented.
func (Drand) Randomness(context.Context, uint64) ([]byte, error) {
	return nil, notimpl.New("timelock.Drand.Randomness")
}

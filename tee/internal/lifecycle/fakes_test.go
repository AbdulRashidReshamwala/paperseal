package lifecycle_test

import (
	"context"
	"errors"

	"paperseal/tee/internal/attestation"
	"paperseal/tee/internal/timelock"
)

const webauthnBackup = 0x08

// toggleBeacon turns a working beacon into one whose rounds don't verify.
type toggleBeacon struct {
	inner timelock.Beacon
	bad   *badBeacon
}

func (b *toggleBeacon) Randomness(ctx context.Context, round uint64) ([]byte, error) {
	if b.bad.on {
		return nil, errors.New("round does not verify against the chain's public key")
	}
	return b.inner.Randomness(ctx, round)
}

func (b *toggleBeacon) Latest(ctx context.Context) (uint64, error) { return b.inner.Latest(ctx) }

// unattested is a launcher that isn't there.
type unattested struct{}

func (unattested) Token(context.Context, attestation.TokenType, string, string) (attestation.Token, error) {
	return attestation.Token{}, attestation.ErrUnattested
}

type badBeacon struct{ on bool }

package lifecycle_test

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"

	"paperseal/tee/internal/attestation"
	"paperseal/tee/internal/storage"
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

// hookStore runs a function before each write, and can hold writes.
type hookStore struct {
	storage.Store
	before func(name string)
	gate   chan struct{}
	enter  chan struct{}
}

func (h *hookStore) Replace(ctx context.Context, name string, data []byte) error {
	h.hold(name)
	return h.Store.Replace(ctx, name, data)
}

func (h *hookStore) Put(ctx context.Context, name string, data []byte) error {
	h.hold(name)
	return h.Store.Put(ctx, name, data)
}

func (h *hookStore) hold(name string) {
	if h.before != nil {
		h.before(name)
	}
	if h.gate != nil && strings.Contains(name, "key-priv") {
		select {
		case h.enter <- struct{}{}:
		default:
		}
		<-h.gate
	}
}

// hookSealer runs a function while sealing, as time passes during it.
type hookSealer struct {
	timelock.Sealer
	during func()
}

func (h hookSealer) Seal(ctx context.Context, round uint64, pt []byte) ([]byte, error) {
	if h.during != nil {
		h.during()
	}
	return h.Sealer.Seal(ctx, round, pt)
}

// flipTokens is a launcher that works until told not to.
type flipTokens struct {
	attestation.TokenSource
	off atomic.Bool
}

func (f *flipTokens) Token(ctx context.Context, t attestation.TokenType, aud, nonce string) (attestation.Token, error) {
	if f.off.Load() {
		return attestation.Token{}, attestation.ErrUnattested
	}
	return f.TokenSource.Token(ctx, t, aud, nonce)
}

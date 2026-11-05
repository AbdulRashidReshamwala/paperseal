// Package timelocktest is a drand chain whose secret key the test holds. It
// signs rounds, so tests can serve verifiable rounds and open timelocked data
// without the network. It is for tests only and the TEE never imports it.
package timelocktest

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	chain "github.com/drand/drand/v2/common"
	"github.com/drand/drand/v2/crypto"
	"github.com/drand/kyber"
	"github.com/drand/kyber/util/random"
	"github.com/drand/tlock"

	"paperseal/tee/internal/spec"
	"paperseal/tee/internal/timelock"
)

// Chain is a quicknet-shaped chain with a known secret.
type Chain struct {
	timelock.Chain
	secret kyber.Scalar
}

// New makes a chain with the quicknet scheme and timing and a fresh key pair.
func New(t testing.TB) *Chain {
	t.Helper()
	scheme, err := crypto.SchemeFromName(spec.C.Drand.Scheme)
	if err != nil {
		t.Fatal(err)
	}
	secret := scheme.KeyGroup.Scalar().Pick(random.New())
	pub := scheme.KeyGroup.Point().Mul(secret, nil)
	return &Chain{
		Chain: timelock.Chain{
			Hash:      spec.C.Drand.ChainHash,
			PublicKey: pub,
			Scheme:    scheme,
			Genesis:   spec.C.Drand.GenesisTime,
			Period:    time.Duration(spec.C.Drand.PeriodSeconds) * time.Second,
		},
		secret: secret,
	}
}

// Round is one signed round in the drand HTTP API shape.
type Round struct {
	Round      uint64 `json:"round"`
	Randomness string `json:"randomness"`
	Signature  string `json:"signature"`
}

// Sign returns the chain's genuine signature for a round.
func (c *Chain) Sign(t testing.TB, round uint64) Round {
	t.Helper()
	digest := c.Scheme.DigestBeacon(&chain.Beacon{Round: round})
	sig, err := c.Scheme.AuthScheme.Sign(c.secret, digest)
	if err != nil {
		t.Fatal(err)
	}
	rnd := sha256.Sum256(sig)
	return Round{round, hex.EncodeToString(rnd[:]), hex.EncodeToString(sig)}
}

// Open decrypts armoured data sealed to round, signing the round itself. It
// plays drand publishing that round, so the caller decides when to call it.
func (c *Chain) Open(t testing.TB, armoured []byte) ([]byte, error) {
	t.Helper()
	var out bytes.Buffer
	err := tlock.New(opener{c, t, 0}).Strict().Decrypt(&out, bytes.NewReader(armoured))
	return out.Bytes(), err
}

// OpenAt is Open, but only if the chain has reached published; an earlier round
// is refused as drand would refuse it.
func (c *Chain) OpenAt(t testing.TB, armoured []byte, published uint64) ([]byte, error) {
	t.Helper()
	var out bytes.Buffer
	err := tlock.New(opener{c, t, published}).Strict().Decrypt(&out, bytes.NewReader(armoured))
	return out.Bytes(), err
}

type opener struct {
	c         *Chain
	t         testing.TB
	published uint64
}

func (o opener) ChainHash() string      { return o.c.Hash }
func (o opener) PublicKey() kyber.Point { return o.c.PublicKey }
func (o opener) Scheme() crypto.Scheme  { return *o.c.Scheme }
func (o opener) Current(time.Time) uint64 {
	return o.published
}
func (o opener) Signature(round uint64) ([]byte, error) {
	if o.published != 0 && round > o.published {
		return nil, errors.New("round not published")
	}
	sig, _ := hex.DecodeString(o.c.Sign(o.t, round).Signature)
	return sig, nil
}
func (opener) SwitchChainHash(string) error { return errors.New("fixed") }

// Fake is a Beacon whose published rounds the test controls. It makes no claim
// to verify anything, because tests of the TEE logic have no use for the
// signatures. HTTPBeacon's own tests cover verification.
type Fake struct {
	mu     sync.Mutex
	latest uint64
}

var _ timelock.Beacon = (*Fake)(nil)

// Set publishes every round up to and including round.
func (f *Fake) Set(round uint64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.latest = round
}

// Randomness returns deterministic bytes for a published round.
func (f *Fake) Randomness(_ context.Context, round uint64) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if round == 0 || round > f.latest {
		return nil, timelock.ErrNotPublished
	}
	sum := sha256.Sum256([]byte(fmt.Sprintf("fake-round-%d", round)))
	return sum[:], nil
}

// Latest returns the newest published round.
func (f *Fake) Latest(context.Context) (uint64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.latest == 0 {
		return 0, timelock.ErrNotPublished
	}
	return f.latest, nil
}

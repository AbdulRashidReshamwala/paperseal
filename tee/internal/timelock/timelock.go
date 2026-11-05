// Package timelock is the drand time seal and the only clock the TEE trusts. The
// timelock itself is drand/tlock, and every round the TEE accepts is checked
// against the public key in spec/constants.json.
package timelock

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"filippo.io/age/armor"
	chain "github.com/drand/drand/v2/common"
	"github.com/drand/drand/v2/crypto"
	"github.com/drand/kyber"
	"github.com/drand/tlock"

	"paperseal/tee/internal/spec"
)

// ErrNotPublished means the round isn't available yet. The TEE treats that as
// "not yet", never as failure.
var ErrNotPublished = errors.New("timelock: round is not published yet")

// Sealer timelocks data to a drand round on quicknet. The output is the
// armoured age format shared by drand/tlock and tlock-js.
type Sealer interface {
	Seal(ctx context.Context, round uint64, plaintext []byte) ([]byte, error)
}

// Beacon reads drand rounds. Implementations must verify each round against
// the public key in spec/constants.json, because the board controls the
// network.
type Beacon interface {
	// Randomness returns a verified round's randomness, or ErrNotPublished if
	// the round isn't available yet.
	Randomness(ctx context.Context, round uint64) ([]byte, error)
	// Latest returns the newest verified round.
	Latest(ctx context.Context) (uint64, error)
}

// Chain holds the parameters of one drand chain. Production uses QuickNet. Tests
// build their own chain with a key pair they hold.
type Chain struct {
	Hash      string
	PublicKey kyber.Point
	Scheme    *crypto.Scheme
	Genesis   int64
	Period    time.Duration
}

// QuickNet is the chain in spec/constants.json.
func QuickNet() (Chain, error) {
	d := spec.C.Drand
	scheme, err := crypto.SchemeFromName(d.Scheme)
	if err != nil {
		return Chain{}, fmt.Errorf("timelock: scheme %q: %w", d.Scheme, err)
	}
	raw, err := hex.DecodeString(d.PublicKey)
	if err != nil {
		return Chain{}, fmt.Errorf("timelock: public key: %w", err)
	}
	pub := scheme.KeyGroup.Point()
	if err := pub.UnmarshalBinary(raw); err != nil {
		return Chain{}, fmt.Errorf("timelock: public key: %w", err)
	}
	return Chain{d.ChainHash, pub, scheme, d.GenesisTime, time.Duration(d.PeriodSeconds) * time.Second}, nil
}

// network is the tlock.Network for a chain. Sealing needs no signatures, so
// Signature is refused: this package never decrypts.
type network struct{ c Chain }

func (n network) ChainHash() string      { return n.c.Hash }
func (n network) PublicKey() kyber.Point { return n.c.PublicKey }
func (n network) Scheme() crypto.Scheme  { return *n.c.Scheme }
func (n network) Current(t time.Time) uint64 {
	if t.Unix() < n.c.Genesis {
		return 1
	}
	return uint64(t.Unix()-n.c.Genesis)/uint64(n.c.Period/time.Second) + 1
}
func (network) Signature(uint64) ([]byte, error) {
	return nil, errors.New("timelock: the TEE only seals")
}
func (network) SwitchChainHash(string) error { return errors.New("timelock: chain is fixed") }

// Drand is the real Sealer for a chain.
type Drand struct{ chain Chain }

var _ Sealer = Drand{}

// NewSealer returns a Sealer for a chain.
func NewSealer(c Chain) Drand { return Drand{c} }

// Seal timelocks plaintext to round with drand/tlock and armours the result.
func (d Drand) Seal(ctx context.Context, round uint64, plaintext []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if round == 0 {
		return nil, errors.New("timelock: round is zero")
	}
	var out bytes.Buffer
	w := armor.NewWriter(&out)
	if err := tlock.New(network{d.chain}).Strict().Encrypt(w, bytes.NewReader(plaintext), round); err != nil {
		return nil, fmt.Errorf("timelock: seal: %w", err)
	}
	if err := w.Close(); err != nil {
		return nil, fmt.Errorf("timelock: armor: %w", err)
	}
	return out.Bytes(), nil
}

// beaconJSON is a drand HTTP API round.
type beaconJSON struct {
	Round      uint64 `json:"round"`
	Randomness string `json:"randomness"`
	Signature  string `json:"signature"`
}

// verify checks one round against the chain's public key and that the
// randomness is the hash of the signature. It returns the randomness.
func (c Chain) verify(b beaconJSON) ([]byte, error) {
	sig, err := hex.DecodeString(b.Signature)
	if err != nil || len(sig) == 0 {
		return nil, errors.New("timelock: round signature is not hex")
	}
	if b.Round == 0 {
		return nil, errors.New("timelock: round is zero")
	}
	if err := c.Scheme.VerifyBeacon(&chain.Beacon{Round: b.Round, Signature: sig}, c.PublicKey); err != nil {
		return nil, fmt.Errorf("timelock: round %d does not verify against the chain's public key: %w", b.Round, err)
	}
	want := crypto.RandomnessFromSignature(sig)
	if got, err := hex.DecodeString(b.Randomness); err != nil || !bytes.Equal(got, want) {
		return nil, fmt.Errorf("timelock: round %d randomness is not the hash of its signature", b.Round)
	}
	return want, nil
}

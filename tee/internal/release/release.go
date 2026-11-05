// Package release collects shares at unlock and delivers K_priv to centres.
// It keeps no long-term state: if the instance stops, holders resubmit.
//
// It serves both ways of starting Unlock in spec/api.md: the instance that ran
// Build passes in what it already knows, and a fresh instance passes in what it
// verified from the chain and storage. Either way, Collector gets the same Facts
// and trusts nothing else.
package release

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strconv"
	"sync"

	"github.com/ethereum/go-ethereum/accounts/abi"

	"paperseal/tee/internal/attestation"
	"paperseal/tee/internal/challenge"
	"paperseal/tee/internal/encryption"
	"paperseal/tee/internal/hashing"
	"paperseal/tee/internal/spec"
	"paperseal/tee/internal/split"
	"paperseal/tee/internal/storage"
	"paperseal/tee/internal/timelock"
	"paperseal/tee/internal/webauthn"
)

// Errors Submit returns. The API maps each to a response.
var (
	ErrTooEarly   = errors.New("release: the unlock round is not published yet")
	ErrTooLate    = errors.New("release: the end round is published, so the paper is already open")
	ErrNotHolder  = errors.New("release: passkey is not a key holder on the approved list")
	ErrDuplicate  = errors.New("release: this holder has already released")
	ErrReleased   = errors.New("release: K_priv is already rebuilt")
	ErrBadRelease = errors.New("release: the release message is invalid")
	ErrBadShare   = errors.New("release: the share does not match its published hash")
)

// Holder is a key holder and the hash of the share published for them.
type Holder struct {
	PasskeyPublicKey []byte
	ShareHash        [32]byte
}

// Facts is everything Unlock trusts. The caller has already checked them: the
// same instance from its own Build, a fresh instance from the chain and the
// manifest.
type Facts struct {
	ExamID      [32]byte
	UnlockRound uint64
	EndRound    uint64
	Holders     []Holder
	// Centres are the derived public keys that receive K_priv, which are roles 3
	// and 4. Neutral parties don't receive it.
	Centres [][]byte
}

// Opener decrypts release messages sent to the instance's encryption key.
type Opener interface {
	Open(p encryption.Purpose, framed []byte) ([]byte, error)
}

// Collector checks shares and rebuilds K_priv once it has enough.
type Collector struct {
	facts      Facts
	opener     Opener
	signer     attestation.Signer
	beacon     timelock.Beacon
	sealer     timelock.Sealer
	store      storage.Store
	challenges *challenge.Store
	tokens     attestation.TokenSource

	mu        sync.Mutex
	entries   []Entry
	shares    map[string][]byte // passkey -> share, until K_priv is rebuilt
	kPriv     []byte            // Held only until it is delivered.
	delivered bool
}

// Deps are the Collector's collaborators.
type Deps struct {
	Opener     Opener
	Signer     attestation.Signer
	Beacon     timelock.Beacon
	Sealer     timelock.Sealer
	Store      storage.Store
	Challenges *challenge.Store
	// Tokens makes the PKI token of this instance, written as release-token.jwt.
	Tokens attestation.TokenSource
}

// New returns a Collector.
func New(f Facts, d Deps) *Collector {
	return &Collector{
		facts: f, opener: d.Opener, signer: d.Signer, beacon: d.Beacon, sealer: d.Sealer,
		store: d.Store, challenges: d.Challenges, tokens: d.Tokens, shares: map[string][]byte{},
	}
}

// Entry is one accepted release, in the order received.
type Entry struct {
	PasskeyPublicKey []byte
	ShareHash        [32]byte
	Round            uint64 // The newest verified drand round when it was accepted.
}

// Progress is the public release status. It never contains a share.
type Progress struct {
	Released [][]byte // Passkey public keys of holders whose shares were accepted.
	Required int
}

// Challenge returns a fresh release challenge.
func (c *Collector) Challenge() ([]byte, error) { return c.challenges.Issue() }

// Progress reports who has released.
func (c *Collector) Progress() Progress {
	c.mu.Lock()
	defer c.mu.Unlock()
	p := Progress{Required: spec.C.Threshold.Required, Released: [][]byte{}}
	for _, e := range c.entries {
		p.Released = append(p.Released, bytes.Clone(e.PasskeyPublicKey))
	}
	return p
}

// Done reports whether K_priv was rebuilt and delivered.
func (c *Collector) Done() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.delivered
}

// Submit checks one holder's release and, at the threshold, rebuilds K_priv
// and delivers it. A failed delivery leaves it pending for Step to retry.
func (c *Collector) Submit(ctx context.Context, passkey, challengeBytes, sealed []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.kPriv != nil || c.delivered {
		return ErrReleased
	}
	// The round is published, as drand says and as verified against its key.
	if _, err := c.beacon.Randomness(ctx, c.facts.UnlockRound); err != nil {
		if errors.Is(err, timelock.ErrNotPublished) {
			return ErrTooEarly
		}
		return err
	}
	if _, err := c.beacon.Randomness(ctx, c.facts.EndRound); err == nil {
		return ErrTooLate
	} else if !errors.Is(err, timelock.ErrNotPublished) {
		return err
	}
	holder, ok := c.holder(passkey)
	if !ok {
		return ErrNotHolder
	}
	for _, e := range c.entries {
		if bytes.Equal(e.PasskeyPublicKey, passkey) {
			return ErrDuplicate
		}
	}
	if err := c.challenges.Consume(challengeBytes); err != nil {
		return fmt.Errorf("%w: %v", ErrBadRelease, err)
	}
	plain, err := c.opener.Open(encryption.PurposeRelease, sealed)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrBadRelease, err)
	}
	share, assertion, err := DecodeRelease(plain)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrBadRelease, err)
	}
	msg, err := hashing.ShareRelease(c.facts.ExamID, challengeBytes)
	if err != nil {
		return err
	}
	if err := webauthn.Verify(passkey, webauthn.TypeGet, msg, assertion); err != nil {
		return fmt.Errorf("%w: %v", ErrBadRelease, err)
	}
	hm, err := hashing.ShareHash(share)
	if err != nil {
		return err
	}
	if hm.Sum() != holder.ShareHash {
		return ErrBadShare
	}
	round, err := c.beacon.Latest(ctx)
	if err != nil {
		return err
	}
	c.entries = append(c.entries, Entry{bytes.Clone(passkey), holder.ShareHash, round})
	c.shares[string(passkey)] = bytes.Clone(share)

	if len(c.entries) < spec.C.Threshold.Required {
		return nil
	}
	var all [][]byte
	for _, e := range c.entries {
		all = append(all, c.shares[string(e.PasskeyPublicKey)])
	}
	kPriv, err := split.CombineShares(all)
	if err != nil {
		return err
	}
	c.kPriv = kPriv
	c.shares = map[string][]byte{}
	// A failure here is not the holder's: the share is accepted, and Step
	// retries the delivery.
	_ = c.deliver(ctx)
	return nil
}

func (c *Collector) holder(passkey []byte) (Holder, bool) {
	for _, h := range c.facts.Holders {
		if bytes.Equal(h.PasskeyPublicKey, passkey) {
			return h, true
		}
	}
	return Holder{}, false
}

// Step retries a delivery that failed. It does nothing before the threshold.
func (c *Collector) Step(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.kPriv == nil {
		return nil
	}
	return c.deliver(ctx)
}

// deliver publishes K_priv encrypted to each centre, K_priv timelocked to the
// end round, this instance's token and the signed log. The log goes last, so it never covers files
// that aren't there. mu is held.
func (c *Collector) deliver(ctx context.Context) error {
	prefix := storage.Prefix(c.facts.ExamID)
	for _, derived := range c.facts.Centres {
		framed, err := encryption.Seal(encryption.PurposeKeyPriv, derived, c.facts.ExamID, c.kPriv)
		if err != nil {
			return err
		}
		if err := c.store.Put(ctx, prefix+"key-priv/"+storage.Hex(derived)+".bin", framed); err != nil {
			return err
		}
	}
	locked, err := c.sealer.Seal(ctx, c.facts.EndRound, c.kPriv)
	if err != nil {
		return err
	}
	if err := c.store.Put(ctx, prefix+"key-priv.tlock", locked); err != nil {
		return err
	}
	// Unlock may run on another instance than Build, so the log names its signer
	// and this token attests that key.
	nonce, err := attestation.Nonce(c.signer.PublicKey(), c.facts.ExamID)
	if err != nil {
		return err
	}
	tok, err := c.tokens.Token(ctx, attestation.TokenPKI, spec.C.Attestation.Audience, nonce)
	if err != nil {
		return err
	}
	if err := c.store.Put(ctx, prefix+"release-token.jwt", []byte(tok.Raw)); err != nil {
		return err
	}
	body, err := c.logLocked()
	if err != nil {
		return err
	}
	if err := c.store.Put(ctx, prefix+"release-log.json", body.JSON); err != nil {
		return err
	}
	for i := range c.kPriv {
		c.kPriv[i] = 0
	}
	c.kPriv = nil
	c.delivered = true
	return nil
}

// LogEntry is one entry of the release log, as JSON.
type LogEntry struct {
	PasskeyPublicKey string `json:"passkeyPublicKey"`
	ShareHash        string `json:"shareHash"`
	Round            string `json:"round"`
}

// Log is the GET /v1/release/log body.
type Log struct {
	ExamID       string     `json:"examId"`
	Entries      []LogEntry `json:"entries"`
	EntriesHash  string     `json:"entriesHash"`
	TEESignature string     `json:"teeSignature"`
	// InstancePublicKey is the signer, which release-token.jwt attests.
	InstancePublicKey string `json:"instancePublicKey"`
	// JSON is the body as published, for storage.
	JSON []byte `json:"-"`
}

// SignedLog returns the log of the releases so far, signed by the instance key.
func (c *Collector) SignedLog() (Log, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.logLocked()
}

func (c *Collector) logLocked() (Log, error) {
	hash, err := EntriesHash(c.entries)
	if err != nil {
		return Log{}, err
	}
	sig, err := c.signer.Sign(hashing.ReleaseLog(c.facts.ExamID, hash))
	if err != nil {
		return Log{}, err
	}
	l := Log{
		ExamID:            storage.Hex(c.facts.ExamID[:]),
		Entries:           []LogEntry{},
		EntriesHash:       storage.Hex(hash[:]),
		TEESignature:      storage.Hex(sig[:]),
		InstancePublicKey: storage.Hex(c.signer.PublicKey()),
	}
	for _, e := range c.entries {
		l.Entries = append(l.Entries, LogEntry{
			storage.Hex(e.PasskeyPublicKey), storage.Hex(e.ShareHash[:]), strconv.FormatUint(e.Round, 10),
		})
	}
	if l.JSON, err = marshalLog(l); err != nil {
		return Log{}, err
	}
	return l, nil
}

var (
	bytesT   = mustType("bytes")
	bytes32T = mustType("bytes32")
	uint64T  = mustType("uint64")
)

func mustType(name string) abi.Type {
	t, err := abi.NewType(name, "", nil)
	if err != nil {
		panic(err)
	}
	return t
}

var entriesArgs = func() abi.Arguments {
	t, err := abi.NewType("tuple[]", "", []abi.ArgumentMarshaling{
		{Name: "passkeyPublicKey", Type: "bytes"},
		{Name: "shareHash", Type: "bytes32"},
		{Name: "round", Type: "uint64"},
	})
	if err != nil {
		panic(err)
	}
	return abi.Arguments{{Type: t}}
}()

// EntriesHash is the plain SHA-256 of abi.encode(ReleaseEntry[]), with
// ReleaseEntry being (bytes passkeyPublicKey, bytes32 shareHash, uint64 round),
// in the order received.
func EntriesHash(entries []Entry) ([32]byte, error) {
	enc, err := EntriesPreimage(entries)
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(enc), nil
}

// EntriesPreimage is abi.encode(ReleaseEntry[]), the bytes entriesHash covers.
func EntriesPreimage(entries []Entry) ([]byte, error) {
	type releaseEntry struct {
		PasskeyPublicKey []byte
		ShareHash        [32]byte
		Round            uint64
	}
	list := make([]releaseEntry, len(entries))
	for i, e := range entries {
		list[i] = releaseEntry{e.PasskeyPublicKey, e.ShareHash, e.Round}
	}
	enc, err := entriesArgs.Pack(list)
	if err != nil {
		return nil, fmt.Errorf("release: encode entries: %w", err)
	}
	return enc, nil
}

var releaseArgs = abi.Arguments{{Type: bytesT}, {Type: bytesT}, {Type: bytesT}, {Type: bytesT}}

// EncodeRelease is the `release` plaintext: abi.encode(bytes share, bytes
// signature, bytes authenticatorData, bytes clientDataJSON). The holder's app
// builds it in TypeScript. Go builds it for tests and vectors.
func EncodeRelease(share []byte, a webauthn.Assertion) ([]byte, error) {
	return releaseArgs.Pack(share, a.Signature, a.AuthenticatorData, a.ClientDataJSON)
}

// DecodeRelease reads the `release` plaintext. ABI decoding tolerates dirty
// padding and trailing bytes, so it re-encodes and refuses any difference.
func DecodeRelease(b []byte) (share []byte, a webauthn.Assertion, err error) {
	vals, err := releaseArgs.Unpack(b)
	if err != nil || len(vals) != 4 {
		return nil, a, errors.New("not abi.encode(bytes, bytes, bytes, bytes)")
	}
	share, _ = vals[0].([]byte)
	a.Signature, _ = vals[1].([]byte)
	a.AuthenticatorData, _ = vals[2].([]byte)
	a.ClientDataJSON, _ = vals[3].([]byte)
	again, err := EncodeRelease(share, a)
	if err != nil || !bytes.Equal(again, b) {
		return nil, a, errors.New("not the canonical encoding")
	}
	if len(share) == 0 {
		return nil, a, errors.New("empty share")
	}
	return share, a, nil
}

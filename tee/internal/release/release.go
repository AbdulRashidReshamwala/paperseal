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
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

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
	ErrStale      = errors.New("release: the relay's newest round is before the unlock round")
	// ErrDeliveryPending is SignedLog's answer between the threshold and the
	// prepared delivery. No log can list the files yet, and a signed one with
	// enough entries and no files would say something false.
	ErrDeliveryPending = errors.New("release: the threshold is reached but the delivery is not prepared yet")
)

// missTTL is how long "this round is not published" is believed. Published
// rounds are cached for good by the beacon, so only the misses need this, and
// without it every request would cost a drand call.
const missTTL = time.Second

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
	now        func() time.Time

	// mu serialises accepting a release and delivering K_priv. It is never held
	// across a beacon call or a signature check. Cheap checks and Progress use
	// pm instead, so a slow delivery doesn't hold them up.
	mu       sync.Mutex
	entries  []Entry
	shares   map[string][]byte // passkey -> share, until K_priv is rebuilt
	kPriv    []byte            // Held only until the delivery is prepared.
	files    []outFile         // The prepared delivery, kept so a retry uploads the same bytes.
	uploaded int               // How many of files are stored.
	log      *Log              // The log prepared for publishing. It outlives files, and is what SignedLog serves from then on.

	pm       sync.RWMutex
	released [][]byte // Passkeys of accepted releases, in order.
	closed   bool     // The threshold was reached, delivered or not, or the collector was wiped.
	done     bool     // K_priv was delivered.

	cacheMu    sync.Mutex
	unlockMiss time.Time // When the unlock round was last seen unpublished.
	endMiss    time.Time // When the end round was last seen unpublished.
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
	// Now only times the cache of unpublished rounds. A nil Now uses the system
	// clock. drand decides every round.
	Now func() time.Time
}

// New returns a Collector.
func New(f Facts, d Deps) *Collector {
	now := d.Now
	if now == nil {
		now = time.Now
	}
	return &Collector{
		facts: f, opener: d.Opener, signer: d.Signer, beacon: d.Beacon, sealer: d.Sealer,
		store: d.Store, challenges: d.Challenges, tokens: d.Tokens, now: now, shares: map[string][]byte{},
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

// published asks whether a round is published. A published round is final, and
// the beacon remembers it. A miss is remembered here for missTTL. No lock is
// held while the beacon is called.
func (c *Collector) published(ctx context.Context, round uint64, miss *time.Time) (bool, error) {
	c.cacheMu.Lock()
	last := *miss
	c.cacheMu.Unlock()
	if !last.IsZero() && c.now().Sub(last) < missTTL {
		return false, nil
	}
	_, err := c.beacon.Randomness(ctx, round)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, timelock.ErrNotPublished):
		c.cacheMu.Lock()
		*miss = c.now()
		c.cacheMu.Unlock()
		return false, nil
	}
	return false, err
}

// checkRounds is ErrTooEarly before the unlock round is published, and
// ErrTooLate once the end round is.
func (c *Collector) checkRounds(ctx context.Context) error {
	ok, err := c.published(ctx, c.facts.UnlockRound, &c.unlockMiss)
	if err != nil {
		return err
	}
	if !ok {
		return ErrTooEarly
	}
	late, err := c.published(ctx, c.facts.EndRound, &c.endMiss)
	if err != nil {
		return err
	}
	if late {
		return ErrTooLate
	}
	return nil
}

// Challenge returns a fresh release challenge. None is issued until the unlock
// round is published, because no release is accepted before then.
func (c *Collector) Challenge(ctx context.Context) ([]byte, error) {
	ok, err := c.published(ctx, c.facts.UnlockRound, &c.unlockMiss)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrTooEarly
	}
	return c.challenges.Issue()
}

// Progress reports who has released. It doesn't wait for a delivery in progress.
func (c *Collector) Progress() Progress {
	c.pm.RLock()
	defer c.pm.RUnlock()
	p := Progress{Required: spec.C.Threshold.Required, Released: [][]byte{}}
	for _, k := range c.released {
		p.Released = append(p.Released, bytes.Clone(k))
	}
	return p
}

// Done reports whether K_priv was rebuilt and delivered.
func (c *Collector) Done() bool {
	c.pm.RLock()
	defer c.pm.RUnlock()
	return c.done
}

// cheap is the part of Submit that needs no network and no cryptography beyond
// a MAC, so a flood of bad requests costs little.
func (c *Collector) cheap(passkey []byte) (Holder, error) {
	c.pm.RLock()
	defer c.pm.RUnlock()
	if c.closed {
		return Holder{}, ErrReleased
	}
	holder, ok := c.holder(passkey)
	if !ok {
		return Holder{}, ErrNotHolder
	}
	for _, k := range c.released {
		if bytes.Equal(k, passkey) {
			return Holder{}, ErrDuplicate
		}
	}
	return holder, nil
}

func wipe(bs ...[]byte) {
	for _, b := range bs {
		clear(b)
	}
}

// Submit checks one holder's release and, at the threshold, rebuilds K_priv
// and delivers it. A failed delivery leaves it pending for Step to retry.
//
// The cheap checks come first: holder, duplicate and the challenge's MAC. Then
// the rounds, then decryption and signatures. None of that holds mu, which is
// taken last, to re-check and to record the release. The challenge is spent
// only once the signature and the share hash have passed, so a request that
// can't produce them can't use up room for others.
func (c *Collector) Submit(ctx context.Context, passkey, challengeBytes, sealed []byte) error {
	holder, err := c.cheap(passkey)
	if err != nil {
		return err
	}
	if err := c.challenges.Check(challengeBytes); err != nil {
		return fmt.Errorf("%w: %v", ErrBadRelease, err)
	}
	// The rounds are published, as drand says and as verified against its key.
	if err := c.checkRounds(ctx); err != nil {
		return err
	}
	plain, err := c.opener.Open(encryption.PurposeRelease, sealed)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrBadRelease, err)
	}
	defer wipe(plain)
	share, assertion, err := DecodeRelease(plain)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrBadRelease, err)
	}
	defer wipe(share)
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
	// The log records the round the release was accepted in, so a relay's stale
	// answer can't put an earlier one on it.
	if round < c.facts.UnlockRound {
		return fmt.Errorf("%w: %d < %d", ErrStale, round, c.facts.UnlockRound)
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	// Another request may have got here first.
	if _, err := c.cheap(passkey); err != nil {
		return err
	}
	if err := c.challenges.Consume(challengeBytes); err != nil {
		if errors.Is(err, challenge.ErrBusy) {
			return err
		}
		return fmt.Errorf("%w: %v", ErrBadRelease, err)
	}
	c.entries = append(c.entries, Entry{bytes.Clone(passkey), holder.ShareHash, round})
	c.shares[string(passkey)] = bytes.Clone(share)
	c.pm.Lock()
	c.released = append(c.released, bytes.Clone(passkey))
	reached := len(c.entries) >= spec.C.Threshold.Required
	if reached {
		c.closed = true
	}
	c.pm.Unlock()
	if !reached {
		return nil
	}
	all := make([][]byte, 0, len(c.entries))
	for _, e := range c.entries {
		all = append(all, c.shares[string(e.PasskeyPublicKey)])
	}
	kPriv, err := split.CombineShares(all)
	for _, sh := range c.shares {
		wipe(sh)
	}
	c.shares = map[string][]byte{}
	if err != nil {
		return err
	}
	c.kPriv = kPriv
	// A failure here is not the holder's: the share is accepted, and Step
	// retries the delivery.
	_ = c.deliver(ctx)
	return nil
}

// Wipe zeroes K_priv and every held share and refuses all further releases. The
// lifecycle calls it when the instance fails for good, so nothing secret
// outlives the failure.
func (c *Collector) Wipe() {
	c.mu.Lock()
	defer c.mu.Unlock()
	wipe(c.kPriv)
	c.kPriv = nil
	for _, sh := range c.shares {
		wipe(sh)
	}
	c.shares = map[string][]byte{}
	c.pm.Lock()
	c.closed = true
	c.pm.Unlock()
}

// holder is read-only on facts, which never change.
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
	if c.kPriv == nil && c.files == nil {
		return nil
	}
	return c.deliver(ctx)
}

// outFile is one file of the delivery, ready to upload.
type outFile struct {
	name string
	data []byte
}

// prepare makes every file of the delivery once: K_priv encrypted to each
// centre, K_priv timelocked to the end round, this instance's token and the
// signed log, which lists the hash of each key-priv file. The log goes last, so
// it never covers files that aren't there.
// Storage is create-only, and encryption, timelocks and signatures are random,
// so a retry must upload these same bytes and not make new ones. Once they are
// made K_priv is no longer needed and is wiped. mu is held.
func (c *Collector) prepare(ctx context.Context) error {
	prefix := storage.Prefix(c.facts.ExamID)
	// The token comes first. If this instance can't make one, nothing has been
	// made or written, so a failed delivery leaves no key-priv files behind.
	nonce, err := attestation.Nonce(c.signer.PublicKey(), c.facts.ExamID)
	if err != nil {
		return err
	}
	tok, err := c.tokens.Token(ctx, attestation.TokenPKI, spec.C.Attestation.Audience, nonce)
	if err != nil {
		return err
	}
	var files []outFile
	var listed []File
	add := func(name string, data []byte) {
		files = append(files, outFile{prefix + name, data})
		listed = append(listed, File{name, sha256.Sum256(data)})
	}
	for _, derived := range c.facts.Centres {
		framed, err := encryption.Seal(encryption.PurposeKeyPriv, derived, c.facts.ExamID, c.kPriv)
		if err != nil {
			return err
		}
		add("key-priv/"+storage.Hex(derived)+".bin", framed)
	}
	locked, err := c.sealer.Seal(ctx, c.facts.EndRound, c.kPriv)
	if err != nil {
		return err
	}
	add("key-priv.tlock", locked)
	// Unlock may run on another instance than Build, so the log names its signer
	// and this token attests that key. These last two aren't listed in the log:
	// the log can't hash itself, and the token is checked by its own signature.
	body, err := c.logLocked(SortFiles(listed))
	if err != nil {
		return err
	}
	c.log = &body
	c.files = append(files,
		outFile{prefix + "release-token.jwt", []byte(tok.Raw)},
		outFile{prefix + "release-log.json", body.JSON},
	)
	wipe(c.kPriv)
	c.kPriv = nil
	return nil
}

// deliver uploads the files, preparing them first if need be. mu is held.
func (c *Collector) deliver(ctx context.Context) error {
	if c.files == nil {
		if err := c.prepare(ctx); err != nil {
			return err
		}
	}
	// These are the unlock files, which a new instance may have to write over
	// after an instance that stopped part way: Replace, not Put.
	for c.uploaded < len(c.files) {
		f := c.files[c.uploaded]
		if err := c.store.Replace(ctx, f.name, f.data); err != nil {
			return err
		}
		c.uploaded++
	}
	c.files = nil
	c.pm.Lock()
	c.done = true
	c.pm.Unlock()
	return nil
}

// LogEntry is one entry of the release log, as JSON.
type LogEntry struct {
	PasskeyPublicKey string `json:"passkeyPublicKey"`
	ShareHash        string `json:"shareHash"`
	Round            string `json:"round"`
}

// LogFile is one file of the release log, as JSON.
type LogFile struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
}

// Log is the GET /v1/release/log body.
type Log struct {
	ExamID      string     `json:"examId"`
	Entries     []LogEntry `json:"entries"`
	EntriesHash string     `json:"entriesHash"`
	// Files is empty until the threshold is reached, then lists key-priv.tlock
	// and one key-priv file per centre, sorted by name.
	Files        []LogFile `json:"files"`
	FilesHash    string    `json:"filesHash"`
	TEESignature string    `json:"teeSignature"`
	// InstancePublicKey is the signer, which release-token.jwt attests.
	InstancePublicKey string `json:"instancePublicKey"`
	// JSON is the body as published, for storage.
	JSON []byte `json:"-"`
}

// SignedLog returns the log of the releases so far, signed by the instance key.
// Once the delivery is prepared it returns the log made for publishing, with
// the same bytes and signature as release-log.json. Signatures are random, so
// signing again would give another log. Between the threshold and that point it
// returns ErrDeliveryPending.
func (c *Collector) SignedLog() (Log, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.log != nil {
		return *c.log, nil
	}
	if len(c.entries) >= spec.C.Threshold.Required {
		return Log{}, ErrDeliveryPending
	}
	return c.logLocked(nil)
}

// logLocked signs a log of the entries so far and files, which must be sorted.
func (c *Collector) logLocked(files []File) (Log, error) {
	hash, err := EntriesHash(c.entries)
	if err != nil {
		return Log{}, err
	}
	filesHash, err := FilesHash(files)
	if err != nil {
		return Log{}, err
	}
	sig, err := c.signer.Sign(hashing.ReleaseLog(c.facts.ExamID, hash, filesHash))
	if err != nil {
		return Log{}, err
	}
	l := Log{
		ExamID:            storage.Hex(c.facts.ExamID[:]),
		Entries:           []LogEntry{},
		EntriesHash:       storage.Hex(hash[:]),
		Files:             []LogFile{},
		FilesHash:         storage.Hex(filesHash[:]),
		TEESignature:      storage.Hex(sig[:]),
		InstancePublicKey: storage.Hex(c.signer.PublicKey()),
	}
	for _, e := range c.entries {
		l.Entries = append(l.Entries, LogEntry{
			storage.Hex(e.PasskeyPublicKey), storage.Hex(e.ShareHash[:]), strconv.FormatUint(e.Round, 10),
		})
	}
	for _, f := range files {
		l.Files = append(l.Files, LogFile{f.Name, storage.Hex(f.SHA256[:])})
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

var filesArgs = func() abi.Arguments {
	t, err := abi.NewType("tuple[]", "", []abi.ArgumentMarshaling{
		{Name: "name", Type: "string"},
		{Name: "sha256", Type: "bytes32"},
	})
	if err != nil {
		panic(err)
	}
	return abi.Arguments{{Type: t}}
}()

// File is one stored file the release log covers. Name is relative to the exam
// folder, as in the manifest. SHA256 is the plain SHA-256 of the stored file.
type File struct {
	Name   string
	SHA256 [32]byte
}

// SortFiles returns a copy of files sorted by name in byte order, the order
// filesHash covers.
func SortFiles(files []File) []File {
	out := slices.Clone(files)
	slices.SortFunc(out, func(a, b File) int { return strings.Compare(a.Name, b.Name) })
	return out
}

// FilesHash is the plain SHA-256 of abi.encode(ReleaseFile[]), with ReleaseFile
// being (string name, bytes32 sha256). See FilesPreimage for the order.
func FilesHash(files []File) ([32]byte, error) {
	enc, err := FilesPreimage(files)
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(enc), nil
}

// FilesPreimage is abi.encode(ReleaseFile[]), the bytes filesHash covers. It
// refuses files that aren't sorted by name without repeats, so the order is set
// in one place, SortFiles, and a repeated name can't reach a signed log.
func FilesPreimage(files []File) ([]byte, error) {
	type releaseFile struct {
		Name   string
		Sha256 [32]byte
	}
	list := make([]releaseFile, len(files))
	for i, f := range files {
		if i > 0 && files[i-1].Name >= f.Name {
			return nil, errors.New("release: files are not sorted by name")
		}
		list[i] = releaseFile{f.Name, f.SHA256}
	}
	enc, err := filesArgs.Pack(list)
	if err != nil {
		return nil, fmt.Errorf("release: encode files: %w", err)
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

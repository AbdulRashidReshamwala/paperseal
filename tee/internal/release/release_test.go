package release

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"paperseal/tee/internal/attestation"
	"paperseal/tee/internal/challenge"
	"paperseal/tee/internal/encryption"
	"paperseal/tee/internal/hashing"
	"paperseal/tee/internal/spec"
	"paperseal/tee/internal/split"
	"paperseal/tee/internal/storage"
	"paperseal/tee/internal/timelock"
	"paperseal/tee/internal/timelock/timelocktest"
	"paperseal/tee/internal/webauthn/webauthntest"
)

const (
	unlockRound = 100
	endRound    = 200
)

type holder struct {
	passkey *webauthntest.Passkey
	derived *encryption.PrivateKey
	share   []byte
	neutral bool
}

type env struct {
	t       *testing.T
	exam    [32]byte
	keys    *attestation.Keys
	beacon  *timelocktest.Fake
	chain   *timelocktest.Chain
	store   *flaky
	holders []*holder
	centres [][]byte
	kPriv   []byte
	c       *Collector
	chals   *challenge.Store
	now     time.Time
	opener  Opener
	tokens  attestation.TokenSource
	beaconI timelock.Beacon
}

// flaky is a storage that can fail writes.
type flaky struct {
	storage.Dir
	fail atomic.Bool
}

func (f *flaky) Replace(ctx context.Context, name string, data []byte) error {
	if f.fail.Load() {
		return errors.New("storage down")
	}
	return f.Dir.Replace(ctx, name, data)
}

func (f *flaky) Put(ctx context.Context, name string, data []byte) error {
	if f.fail.Load() {
		return errors.New("storage down")
	}
	return f.Dir.Put(ctx, name, data)
}

func setup(t *testing.T) *env {
	t.Helper()
	return setupWith(t, nil)
}

// setupWith lets a test swap the collector's collaborators.
func setupWith(t *testing.T, tweak func(*env)) *env {
	t.Helper()
	e := &env{t: t, beacon: &timelocktest.Fake{}, chain: timelocktest.New(t), now: time.Unix(5000, 0)}
	e.chals = challenge.New(func() time.Time { return e.now })
	e.exam[0] = 5
	var err error
	if e.keys, err = attestation.NewKeys(e.exam); err != nil {
		t.Fatal(err)
	}
	e.store = &flaky{Dir: storage.Dir{Root: t.TempDir()}}
	e.kPriv = make([]byte, 32)
	rand.Read(e.kPriv)
	shares, err := split.SplitShares(e.kPriv)
	if err != nil {
		t.Fatal(err)
	}
	var facts Facts
	facts.ExamID, facts.UnlockRound, facts.EndRound = e.exam, unlockRound, endRound
	for i, share := range shares {
		ikm := make([]byte, 32)
		rand.Read(ikm)
		d, err := encryption.DeriveKey(ikm)
		if err != nil {
			t.Fatal(err)
		}
		h := &holder{passkey: webauthntest.New(t), derived: d, share: share, neutral: i < spec.C.Threshold.Neutrals}
		sh, _ := hashing.ShareHash(share)
		facts.Holders = append(facts.Holders, Holder{h.passkey.PublicKey(), sh.Sum()})
		facts.Centres = append(facts.Centres, d.PublicKey())
		e.holders = append(e.holders, h)
	}
	// Neutral parties hold shares but don't receive K_priv.
	facts.Centres = facts.Centres[spec.C.Threshold.Neutrals:]
	e.centres = facts.Centres
	e.opener, e.tokens, e.beaconI = e.keys, fakeTokens{}, e.beacon
	e.beacon.Set(unlockRound)
	if tweak != nil {
		tweak(e)
	}
	e.c = New(facts, Deps{
		Opener: e.opener, Signer: e.keys, Beacon: e.beaconI, Sealer: timelock.NewSealer(e.chain.Chain),
		Store: e.store, Challenges: e.chals, Tokens: e.tokens, Now: func() time.Time { return e.now },
	})
	return e
}

// release plays one holder's app: a challenge, a passkey signature, and a
// sealed message to the instance's encryption key.
func (e *env) release(h *holder, mutate func(share *[]byte, challenge *[]byte)) error {
	e.t.Helper()
	ch, err := e.c.Challenge(context.Background())
	if err != nil {
		e.t.Fatal(err)
	}
	return e.releaseWith(h, ch, mutate)
}

func (e *env) releaseWith(h *holder, ch []byte, mutate func(share *[]byte, challenge *[]byte)) error {
	e.t.Helper()
	share := h.share
	signedChallenge := ch
	if mutate != nil {
		mutate(&share, &signedChallenge)
	}
	msg, _ := hashing.ShareRelease(e.exam, signedChallenge)
	plain, err := EncodeRelease(share, h.passkey.Sign(e.t, msg))
	if err != nil {
		e.t.Fatal(err)
	}
	sealed, err := encryption.Seal(encryption.PurposeRelease, e.keys.EncryptionPublicKey(), e.exam, plain)
	if err != nil {
		e.t.Fatal(err)
	}
	return e.c.Submit(context.Background(), h.passkey.PublicKey(), ch, sealed)
}

func (e *env) releaseN(n int) {
	e.t.Helper()
	for _, h := range e.holders[:n] {
		if err := e.release(h, nil); err != nil {
			e.t.Fatalf("release: %v", err)
		}
	}
}

func TestEightSharesRebuildAndDeliver(t *testing.T) {
	e := setup(t)
	e.releaseN(8)
	if !e.c.Done() {
		t.Fatal("not delivered after 8 shares")
	}
	prefix := storage.Prefix(e.exam)
	ctx := context.Background()

	// Every centre opens its copy with its derived key and gets K_priv.
	for _, h := range e.holders[spec.C.Threshold.Neutrals:] {
		framed, err := e.store.Get(ctx, prefix+"key-priv/"+storage.Hex(h.derived.PublicKey())+".bin")
		if err != nil {
			t.Fatal(err)
		}
		got, err := h.derived.Open(encryption.PurposeKeyPriv, e.exam, framed)
		if err != nil || !bytes.Equal(got, e.kPriv) {
			t.Fatalf("centre did not recover K_priv: %v", err)
		}
	}
	// Neutral parties get nothing.
	for _, h := range e.holders[:spec.C.Threshold.Neutrals] {
		if _, err := e.store.Get(ctx, prefix+"key-priv/"+storage.Hex(h.derived.PublicKey())+".bin"); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("a neutral party got K_priv: %v", err)
		}
	}
	// The timelocked copy opens at the end round, and not before.
	locked, err := e.store.Get(ctx, prefix+"key-priv.tlock")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.chain.OpenAt(t, locked, endRound-1); err == nil {
		t.Fatal("K_priv copy opened before the end round")
	}
	if got, err := e.chain.OpenAt(t, locked, endRound); err != nil || !bytes.Equal(got, e.kPriv) {
		t.Fatalf("K_priv copy at end round: %v", err)
	}
	// The log is stored, signed, and covers the entries in order received.
	body, err := e.store.Get(ctx, prefix+"release-log.json")
	if err != nil {
		t.Fatal(err)
	}
	var log Log
	if err := json.Unmarshal(body, &log); err != nil {
		t.Fatal(err)
	}
	if len(log.Entries) != 8 || log.Entries[0].Round != "100" {
		t.Fatalf("log: %+v", log)
	}
	for i, en := range log.Entries {
		if en.PasskeyPublicKey != storage.Hex(e.holders[i].passkey.PublicKey()) {
			t.Fatalf("entry %d out of order", i)
		}
	}
	want, _ := EntriesHash(e.c.entries)
	if log.EntriesHash != storage.Hex(want[:]) {
		t.Fatal("entriesHash")
	}
	var sig [64]byte
	raw, _ := hex.DecodeString(log.TEESignature[2:])
	copy(sig[:], raw)
	if err := attestation.Verify(e.keys.PublicKey(), hashing.ReleaseLog(e.exam, want), sig); err != nil {
		t.Fatalf("log signature: %v", err)
	}
	// The instance's own token is stored, for the nonce that binds its key.
	tok, err := e.store.Get(ctx, prefix+"release-token.jwt")
	nonce, _ := attestation.Nonce(e.keys.PublicKey(), e.exam)
	if err != nil || string(tok) != "a.b."+nonce {
		t.Fatalf("release token: %q %v", tok, err)
	}
	if log.InstancePublicKey != storage.Hex(e.keys.PublicKey()) {
		t.Fatal("the log does not name its signer")
	}
	// Nothing more is accepted.
	if err := e.release(e.holders[8], nil); !errors.Is(err, ErrReleased) {
		t.Fatalf("after release: %v", err)
	}
	if got := len(e.c.Progress().Released); got != 8 {
		t.Fatalf("released %d", got)
	}
}

func TestSevenSharesReleaseNothing(t *testing.T) {
	e := setup(t)
	e.releaseN(7)
	if e.c.Done() {
		t.Fatal("delivered with 7")
	}
	if p := e.c.Progress(); len(p.Released) != 7 || p.Required != 8 {
		t.Fatalf("progress %+v", p)
	}
	entries, _ := os.ReadDir(e.store.Root)
	if len(entries) != 0 {
		t.Fatalf("files written with 7 shares: %v", entries)
	}
	// 7 shares don't rebuild K_priv, which is what Shamir promises.
	var shares [][]byte
	for _, h := range e.holders[:7] {
		shares = append(shares, h.share)
	}
	if _, err := split.CombineShares(shares); !errors.Is(err, split.ErrTooFewShares) {
		t.Fatalf("7 shares combined: %v", err)
	}
	// The log so far is signed and lists seven.
	l, err := e.c.SignedLog()
	if err != nil || len(l.Entries) != 7 {
		t.Fatalf("log: %v", err)
	}
	// An eighth completes it.
	if err := e.release(e.holders[7], nil); err != nil || !e.c.Done() {
		t.Fatalf("eighth: %v", err)
	}
}

func TestRoundGate(t *testing.T) {
	e := setup(t)
	ch, err := e.c.Challenge(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	e.beacon.Set(unlockRound - 1)
	e.now = e.now.Add(2 * time.Second) // Past the cache of what was published.
	if err := e.releaseWith(e.holders[0], ch, nil); !errors.Is(err, ErrTooEarly) {
		t.Fatalf("before the unlock round: %v", err)
	}
	e.beacon.Set(endRound)
	e.now = e.now.Add(2 * time.Second)
	if err := e.releaseWith(e.holders[0], ch, nil); !errors.Is(err, ErrTooLate) {
		t.Fatalf("at the end round: %v", err)
	}
	e.beacon.Set(unlockRound)
	e.now = e.now.Add(2 * time.Second)
	if err := e.releaseWith(e.holders[0], ch, nil); err != nil {
		t.Fatalf("at the unlock round: %v", err)
	}
}

func TestRejections(t *testing.T) {
	e := setup(t)
	h := e.holders[0]

	// A passkey that isn't a key holder.
	stranger := &holder{passkey: webauthntest.New(t), share: h.share}
	if err := e.release(stranger, nil); !errors.Is(err, ErrNotHolder) {
		t.Errorf("stranger: %v", err)
	}
	// A wrong share fails its published hash.
	if err := e.release(h, func(s *[]byte, _ *[]byte) { *s = e.holders[1].share }); !errors.Is(err, ErrBadShare) {
		t.Errorf("wrong share: %v", err)
	}
	// A signature over another challenge.
	if err := e.release(h, func(_ *[]byte, c *[]byte) { *c = bytes.Repeat([]byte{1}, 32) }); !errors.Is(err, ErrBadRelease) {
		t.Errorf("wrong challenge: %v", err)
	}
	// A challenge the TEE never issued.
	msg, _ := hashing.ShareRelease(e.exam, bytes.Repeat([]byte{2}, 32))
	plain, _ := EncodeRelease(h.share, h.passkey.Sign(t, msg))
	sealed, _ := encryption.Seal(encryption.PurposeRelease, e.keys.EncryptionPublicKey(), e.exam, plain)
	if err := e.c.Submit(context.Background(), h.passkey.PublicKey(), bytes.Repeat([]byte{2}, 32), sealed); !errors.Is(err, ErrBadRelease) {
		t.Errorf("unissued challenge: %v", err)
	}
	// Garbage that doesn't open.
	ch, _ := e.c.Challenge(context.Background())
	if err := e.c.Submit(context.Background(), h.passkey.PublicKey(), ch, []byte("junk")); !errors.Is(err, ErrBadRelease) {
		t.Errorf("junk: %v", err)
	}
	// A message sealed for another purpose.
	ch, _ = e.c.Challenge(context.Background())
	msg, _ = hashing.ShareRelease(e.exam, ch)
	plain, _ = EncodeRelease(h.share, h.passkey.Sign(t, msg))
	wrongPurpose, _ := encryption.Seal(encryption.PurposeShare, e.keys.EncryptionPublicKey(), e.exam, plain)
	if err := e.c.Submit(context.Background(), h.passkey.PublicKey(), ch, wrongPurpose); !errors.Is(err, ErrBadRelease) {
		t.Errorf("wrong purpose: %v", err)
	}
	// A synced passkey (backup flags) is refused.
	synced := *h.passkey
	synced.Flags = webauthntest.UP | webauthntest.UV | webauthntest.BE
	if err := e.release(&holder{passkey: &synced, share: h.share}, nil); !errors.Is(err, ErrBadRelease) {
		t.Errorf("synced passkey: %v", err)
	}
	if len(e.c.Progress().Released) != 0 {
		t.Fatal("a bad release was counted")
	}

	// A good one is accepted once.
	if err := e.release(h, nil); err != nil {
		t.Fatal(err)
	}
	if err := e.release(h, nil); !errors.Is(err, ErrDuplicate) {
		t.Errorf("duplicate: %v", err)
	}
	// A spent challenge can't be replayed.
	ch, _ = e.c.Challenge(context.Background())
	h2 := e.holders[1]
	msg, _ = hashing.ShareRelease(e.exam, ch)
	plain, _ = EncodeRelease(h2.share, h2.passkey.Sign(t, msg))
	sealed, _ = encryption.Seal(encryption.PurposeRelease, e.keys.EncryptionPublicKey(), e.exam, plain)
	if err := e.c.Submit(context.Background(), h2.passkey.PublicKey(), ch, sealed); err != nil {
		t.Fatal(err)
	}
	if err := e.c.Submit(context.Background(), h2.passkey.PublicKey(), ch, sealed); !errors.Is(err, ErrDuplicate) {
		t.Errorf("replay: %v", err)
	}
}

func TestStorageFailureIsRetried(t *testing.T) {
	e := setup(t)
	e.store.fail.Store(true)
	e.releaseN(8)
	if e.c.Done() {
		t.Fatal("done while storage is down")
	}
	// The eighth share was accepted. A further submission is refused.
	if err := e.release(e.holders[8], nil); !errors.Is(err, ErrReleased) {
		t.Fatalf("%v", err)
	}
	if err := e.c.Step(context.Background()); err == nil {
		t.Fatal("step succeeded while storage is down")
	}
	e.store.fail.Store(false)
	if err := e.c.Step(context.Background()); err != nil || !e.c.Done() {
		t.Fatalf("retry: %v", err)
	}
	// The log was written last, after everything it covers.
	if _, err := e.store.Get(context.Background(), storage.Prefix(e.exam)+"release-log.json"); err != nil {
		t.Fatal(err)
	}
}

func TestReleasePlaintextCodec(t *testing.T) {
	p := webauthntest.New(t)
	msg, _ := hashing.ShareRelease([32]byte{}, []byte{1})
	a := p.Sign(t, msg)
	b, err := EncodeRelease([]byte("share"), a)
	if err != nil {
		t.Fatal(err)
	}
	share, got, err := DecodeRelease(b)
	if err != nil || string(share) != "share" || !bytes.Equal(got.Signature, a.Signature) ||
		!bytes.Equal(got.AuthenticatorData, a.AuthenticatorData) || !bytes.Equal(got.ClientDataJSON, a.ClientDataJSON) {
		t.Fatalf("round trip: %v", err)
	}
	if _, _, err := DecodeRelease(append(b, 0)); err == nil {
		t.Error("accepted trailing bytes")
	}
	if _, _, err := DecodeRelease(b[:len(b)-32]); err == nil {
		t.Error("accepted a truncated message")
	}
	if _, _, err := DecodeRelease(nil); err == nil {
		t.Error("accepted nothing")
	}
}

// fakeTokens stands in for the launcher: it returns a placeholder string the
// release package only stores. Verification is attestation's job and is tested
// there.
type fakeTokens struct{}

func (fakeTokens) Token(_ context.Context, _ attestation.TokenType, _, nonce string) (attestation.Token, error) {
	return attestation.Token{Type: attestation.TokenPKI, Raw: "a.b." + nonce}, nil
}

// countingBeacon wraps the fake beacon, counts calls and can block or lie.
type countingBeacon struct {
	*timelocktest.Fake
	calls  atomic.Int64
	enter  chan struct{} // Signalled on each Randomness call, if set.
	gate   chan struct{} // Randomness waits on this, if set.
	latest func() (uint64, error)
}

func (b *countingBeacon) Randomness(ctx context.Context, round uint64) ([]byte, error) {
	b.calls.Add(1)
	if b.enter != nil {
		select {
		case b.enter <- struct{}{}:
		default:
		}
	}
	if b.gate != nil {
		<-b.gate
	}
	return b.Fake.Randomness(ctx, round)
}

func (b *countingBeacon) Latest(ctx context.Context) (uint64, error) {
	if b.latest != nil {
		return b.latest()
	}
	return b.Fake.Latest(ctx)
}

func withBeacon(cb *countingBeacon) func(*env) {
	return func(e *env) { cb.Fake = e.beacon; e.beaconI = cb }
}

func TestNoReleaseChallengeBeforeUnlockRound(t *testing.T) {
	e := setup(t)
	e.beacon.Set(unlockRound - 1)
	if _, err := e.c.Challenge(context.Background()); !errors.Is(err, ErrTooEarly) {
		t.Fatalf("challenge before the unlock round: %v", err)
	}
	e.beacon.Set(unlockRound)
	e.now = e.now.Add(2 * time.Second)
	if _, err := e.c.Challenge(context.Background()); err != nil {
		t.Fatalf("challenge at the unlock round: %v", err)
	}
}

func TestChallengesStoreNothing(t *testing.T) {
	e := setup(t)
	for range 20000 {
		if _, err := e.c.Challenge(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	// A challenge that was issued still works afterwards.
	if err := e.release(e.holders[0], nil); err != nil {
		t.Fatal(err)
	}
}

// Strangers and repeats are turned away before drand is asked anything.
func TestCheapChecksComeBeforeTheBeacon(t *testing.T) {
	cb := &countingBeacon{}
	e := setupWith(t, withBeacon(cb))
	ch, _ := e.c.Challenge(context.Background())
	e.releaseN(1)
	before := cb.calls.Load()
	e.beacon.Set(unlockRound - 1)
	e.now = e.now.Add(5 * time.Second)
	stranger := &holder{passkey: webauthntest.New(t), share: e.holders[0].share}
	if err := e.releaseWith(stranger, ch, nil); !errors.Is(err, ErrNotHolder) {
		t.Fatalf("stranger: %v", err)
	}
	if err := e.releaseWith(e.holders[0], ch, nil); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("repeat: %v", err)
	}
	if err := e.c.Submit(context.Background(), e.holders[1].passkey.PublicKey(), []byte("forged"), []byte("x")); !errors.Is(err, ErrBadRelease) {
		t.Fatalf("forged challenge: %v", err)
	}
	if got := cb.calls.Load() - before; got != 0 {
		t.Fatalf("drand was asked %d times for requests that fail cheaply", got)
	}
}

// "Not published" is believed for about a second, so a flood doesn't become a
// flood of drand calls.
func TestUnpublishedIsCachedForASecond(t *testing.T) {
	cb := &countingBeacon{}
	e := setupWith(t, withBeacon(cb))
	chs := make([][]byte, 30)
	for i := range chs {
		chs[i], _ = e.c.Challenge(context.Background())
	}
	e.beacon.Set(unlockRound - 1)
	e.now = e.now.Add(5 * time.Second)
	before := cb.calls.Load()
	for _, ch := range chs {
		if err := e.releaseWith(e.holders[0], ch, nil); !errors.Is(err, ErrTooEarly) {
			t.Fatalf("%v", err)
		}
	}
	if got := cb.calls.Load() - before; got != 1 {
		t.Fatalf("%d drand calls for 30 requests in one second, want 1", got)
	}
	e.now = e.now.Add(1100 * time.Millisecond)
	e.releaseWith(e.holders[0], chs[0], nil)
	if got := cb.calls.Load() - before; got != 2 {
		t.Fatalf("%d drand calls after the cache lapsed, want 2", got)
	}
}

// A slow drand call must not stop Progress or the cheap rejections, which is
// what happened while the beacon was called under the lock.
func TestSlowBeaconDoesNotBlockOthers(t *testing.T) {
	cb := &countingBeacon{enter: make(chan struct{}, 1)}
	e := setupWith(t, withBeacon(cb))
	ch, _ := e.c.Challenge(context.Background())
	e.now = e.now.Add(5 * time.Second) // Nothing cached.
	cb.gate = make(chan struct{})
	cb.enter = make(chan struct{}, 1)
	slow := make(chan error, 1)
	go func() { slow <- e.releaseWith(e.holders[0], ch, nil) }()
	<-cb.enter

	done := make(chan struct{})
	go func() {
		e.c.Progress()
		e.c.Submit(context.Background(), webauthntest.New(t).PublicKey(), nil, nil)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Progress and a cheap rejection waited for a slow beacon call")
	}
	close(cb.gate)
	if err := <-slow; err != nil {
		t.Fatal(err)
	}
}

// Two requests for one holder race: one wins and the other is a duplicate.
func TestConcurrentDuplicateIsCaughtUnderTheLock(t *testing.T) {
	e := setup(t)
	h := e.holders[0]
	var chs [2][]byte
	var sealed [2][]byte
	for i := range chs {
		chs[i], _ = e.c.Challenge(context.Background())
		msg, _ := hashing.ShareRelease(e.exam, chs[i])
		plain, _ := EncodeRelease(h.share, h.passkey.Sign(t, msg))
		sealed[i], _ = encryption.Seal(encryption.PurposeRelease, e.keys.EncryptionPublicKey(), e.exam, plain)
	}
	errs := make(chan error, 2)
	for i := range 2 {
		go func() { errs <- e.c.Submit(context.Background(), h.passkey.PublicKey(), chs[i], sealed[i]) }()
	}
	var ok, dup int
	for range 2 {
		switch err := <-errs; {
		case err == nil:
			ok++
		case errors.Is(err, ErrDuplicate):
			dup++
		default:
			t.Fatal(err)
		}
	}
	if ok != 1 || len(e.c.entries) != 1 {
		t.Fatalf("ok=%d dup=%d entries=%d", ok, dup, len(e.c.entries))
	}
}

// A relay that serves an old "latest" round must not put it in the log.
func TestStaleLatestRoundIsNotLogged(t *testing.T) {
	cb := &countingBeacon{latest: func() (uint64, error) { return unlockRound - 1, nil }}
	e := setupWith(t, withBeacon(cb))
	if err := e.release(e.holders[0], nil); !errors.Is(err, ErrStale) {
		t.Fatalf("stale latest: %v", err)
	}
	if len(e.c.Progress().Released) != 0 || len(e.c.entries) != 0 {
		t.Fatal("a release with a stale round was recorded")
	}
	// The challenge wasn't spent, so the holder can try again.
	cb.latest = nil
	if err := e.release(e.holders[0], nil); err != nil {
		t.Fatalf("retry: %v", err)
	}
}

// A challenge is spent only after the signature and the share hash pass.
func TestBadReleaseDoesNotSpendTheChallenge(t *testing.T) {
	e := setup(t)
	ch, _ := e.c.Challenge(context.Background())
	if err := e.releaseWith(e.holders[0], ch, func(s *[]byte, _ *[]byte) { *s = e.holders[1].share }); !errors.Is(err, ErrBadShare) {
		t.Fatalf("%v", err)
	}
	if err := e.releaseWith(e.holders[0], ch, nil); err != nil {
		t.Fatalf("the genuine release with the same challenge: %v", err)
	}
}

// recordingOpener keeps the plaintext it hands out, to see it zeroed.
type recordingOpener struct {
	inner Opener
	plain [][]byte
}

func (r *recordingOpener) Open(p encryption.Purpose, framed []byte) ([]byte, error) {
	b, err := r.inner.Open(p, framed)
	if err == nil {
		r.plain = append(r.plain, b)
	}
	return b, err
}

func allZero(b []byte) bool {
	for _, c := range b {
		if c != 0 {
			return false
		}
	}
	return true
}

func TestPlaintextAndSharesAreZeroedAfterUse(t *testing.T) {
	rec := &recordingOpener{}
	e := setupWith(t, func(e *env) { rec.inner = e.keys; e.opener = rec })
	e.releaseN(7)
	// A rejected release is zeroed as well, here one with the wrong share hash.
	if err := e.release(e.holders[7], func(s *[]byte, _ *[]byte) { *s = e.holders[8].share }); !errors.Is(err, ErrBadShare) {
		t.Fatal(err)
	}
	for i, p := range rec.plain {
		if !allZero(p) {
			t.Fatalf("plaintext %d was left in memory", i)
		}
	}
}

func TestHeldSharesAreZeroedOnceCombined(t *testing.T) {
	e := setup(t)
	e.releaseN(7)
	var held [][]byte
	for _, v := range e.c.shares {
		held = append(held, v)
	}
	if err := e.release(e.holders[7], nil); err != nil {
		t.Fatal(err)
	}
	for i, v := range held {
		if !allZero(v) {
			t.Fatalf("held share %d was left in memory", i)
		}
	}
	if len(e.c.shares) != 0 {
		t.Fatal("the shares map was kept")
	}
}

type failTokens struct{}

func (failTokens) Token(context.Context, attestation.TokenType, string, string) (attestation.Token, error) {
	return attestation.Token{}, attestation.ErrUnattested
}

// With no token to make, nothing is written, and Wipe clears K_priv.
func TestTokenIsFetchedBeforeAnyKeyPrivFile(t *testing.T) {
	e := setupWith(t, func(e *env) { e.tokens = failTokens{} })
	e.releaseN(8)
	if e.c.Done() {
		t.Fatal("done without a token")
	}
	if err := e.c.Step(context.Background()); !errors.Is(err, attestation.ErrUnattested) {
		t.Fatalf("step: %v", err)
	}
	if entries, _ := os.ReadDir(e.store.Root); len(entries) != 0 {
		t.Fatalf("files written before the token: %v", entries)
	}
	kPriv := e.c.kPriv
	if kPriv == nil || allZero(kPriv) {
		t.Fatal("test setup: K_priv should be pending")
	}
	e.c.Wipe()
	if !allZero(kPriv) || e.c.kPriv != nil {
		t.Fatal("Wipe left K_priv in memory")
	}
	if err := e.release(e.holders[8], nil); !errors.Is(err, ErrReleased) {
		t.Fatalf("after Wipe: %v", err)
	}
	if err := e.c.Step(context.Background()); err != nil {
		t.Fatalf("step after Wipe: %v", err)
	}
}

// createOnly refuses to replace a file with different bytes, as the bucket
// does, and fails one chosen write once.
type createOnly struct {
	storage.Store
	t      *testing.T
	failAt int
	puts   int
	seen   map[string][]byte
}

func (c *createOnly) Replace(ctx context.Context, name string, data []byte) error {
	return c.Put(ctx, name, data)
}

func (c *createOnly) Put(ctx context.Context, name string, data []byte) error {
	c.puts++
	if c.puts == c.failAt {
		return errors.New("storage hiccup")
	}
	if old, ok := c.seen[name]; ok && !bytes.Equal(old, data) {
		c.t.Errorf("%s was written again with other bytes", name)
		return storage.ErrExists
	}
	c.seen[name] = bytes.Clone(data)
	return c.Store.Put(ctx, name, data)
}

// Encryption, the timelock and the signature are random, so a retry after a
// partial upload must send the files it made the first time.
func TestRetryUploadsTheSameBytes(t *testing.T) {
	e := setup(t)
	co := &createOnly{Store: e.store, t: t, failAt: 3, seen: map[string][]byte{}}
	e.c.store = co
	e.releaseN(8) // The third upload fails inside Submit.
	if e.c.Done() {
		t.Fatal("done after a failed upload")
	}
	if e.c.kPriv != nil {
		t.Fatal("K_priv is kept once the files are made")
	}
	if err := e.c.Step(context.Background()); err != nil || !e.c.Done() {
		t.Fatalf("retry: %v", err)
	}
	if co.puts < 5 {
		t.Fatalf("only %d writes", co.puts)
	}
}

// bucketLike is create-only for Put and open for Replace, as the bucket is.
type bucketLike struct {
	storage.Dir
	failAfter int // Replace calls allowed before one fails, if > 0.
	replaces  int
}

func (b *bucketLike) Put(ctx context.Context, name string, data []byte) error {
	if old, err := b.Dir.Get(ctx, name); err == nil && !bytes.Equal(old, data) {
		return storage.ErrExists
	}
	return b.Dir.Put(ctx, name, data)
}

func (b *bucketLike) Replace(ctx context.Context, name string, data []byte) error {
	b.replaces++
	if b.failAfter > 0 && b.replaces > b.failAfter {
		return errors.New("instance died")
	}
	return b.Dir.Replace(ctx, name, data)
}

// An Unlock instance dies after writing some key-priv files. A fresh instance,
// with its own keys, takes the holders' resubmitted releases and finishes. HPKE
// and the timelock differ per run, so it has to replace what is there, and the
// centres must still decrypt K_priv.
func TestFreshInstanceFinishesAfterAnInstanceDiedMidDelivery(t *testing.T) {
	store := &bucketLike{Dir: storage.Dir{Root: t.TempDir()}, failAfter: 3}
	e := setupWith(t, func(e *env) { e.store = &flaky{Dir: store.Dir} })
	e.c.store = store
	e.releaseN(8) // The delivery dies on its fourth write.
	if e.c.Done() {
		t.Fatal("setup: the first instance finished")
	}
	prefix := storage.Prefix(e.exam)
	ctx := context.Background()
	first, err := store.Get(ctx, prefix+"key-priv/"+storage.Hex(e.centres[0])+".bin")
	if err != nil {
		t.Fatalf("setup: no key-priv file was written: %v", err)
	}

	// The first instance is gone. A new one has new keys and no memory.
	keys2, err := attestation.NewKeys(e.exam)
	if err != nil {
		t.Fatal(err)
	}
	store.failAfter = 0
	e2 := *e
	e2.keys = keys2
	e2.c = New(e.c.facts, Deps{
		Opener: keys2, Signer: keys2, Beacon: e.beacon, Sealer: timelock.NewSealer(e.chain.Chain),
		Store: store, Challenges: challenge.New(nil), Tokens: fakeTokens{}, Now: func() time.Time { return e.now },
	})
	e2.releaseN(8)
	if !e2.c.Done() {
		t.Fatal("the fresh instance did not finish")
	}
	second, _ := store.Get(ctx, prefix+"key-priv/"+storage.Hex(e.centres[0])+".bin")
	if bytes.Equal(first, second) {
		t.Fatal("setup: expected a new ciphertext, which is why Replace is needed")
	}
	// Every centre decrypts K_priv, which is the same one.
	for _, h := range e.holders[spec.C.Threshold.Neutrals:] {
		framed, err := store.Get(ctx, prefix+"key-priv/"+storage.Hex(h.derived.PublicKey())+".bin")
		if err != nil {
			t.Fatal(err)
		}
		got, err := h.derived.Open(encryption.PurposeKeyPriv, e.exam, framed)
		if err != nil || !bytes.Equal(got, e.kPriv) {
			t.Fatalf("a centre can't decrypt K_priv: %v", err)
		}
	}
	// key-priv.tlock still opens at the end round, to the same K_priv.
	locked, err := store.Get(ctx, prefix+"key-priv.tlock")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := e.chain.OpenAt(t, locked, endRound); err != nil || !bytes.Equal(got, e.kPriv) {
		t.Fatalf("key-priv.tlock does not open to K_priv: %v", err)
	}
	// The log and token are the new instance's, and the log names its signer.
	body, _ := store.Get(ctx, prefix+"release-log.json")
	var log Log
	if err := json.Unmarshal(body, &log); err != nil || log.InstancePublicKey != storage.Hex(keys2.PublicKey()) {
		t.Fatalf("the log does not name the fresh instance: %v", err)
	}
	nonce, _ := attestation.Nonce(keys2.PublicKey(), e.exam)
	if tok, _ := store.Get(ctx, prefix+"release-token.jwt"); string(tok) != "a.b."+nonce {
		t.Fatalf("token %q", tok)
	}
}

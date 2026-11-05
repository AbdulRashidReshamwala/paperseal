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
}

// flaky is a storage that can fail writes.
type flaky struct {
	storage.Dir
	fail atomic.Bool
}

func (f *flaky) Put(ctx context.Context, name string, data []byte) error {
	if f.fail.Load() {
		return errors.New("storage down")
	}
	return f.Dir.Put(ctx, name, data)
}

func setup(t *testing.T) *env {
	t.Helper()
	e := &env{t: t, beacon: &timelocktest.Fake{}, chain: timelocktest.New(t), chals: challenge.New(nil)}
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
	e.c = New(facts, Deps{
		Opener: e.keys, Signer: e.keys, Beacon: e.beacon, Sealer: timelock.NewSealer(e.chain.Chain),
		Store: e.store, Challenges: e.chals, Tokens: fakeTokens{},
	})
	e.beacon.Set(unlockRound)
	return e
}

// release plays one holder's app: a challenge, a passkey signature, and a
// sealed message to the instance's encryption key.
func (e *env) release(h *holder, mutate func(share *[]byte, challenge *[]byte)) error {
	e.t.Helper()
	ch, err := e.c.Challenge()
	if err != nil {
		e.t.Fatal(err)
	}
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
	e.beacon.Set(unlockRound - 1)
	if err := e.release(e.holders[0], nil); !errors.Is(err, ErrTooEarly) {
		t.Fatalf("before the unlock round: %v", err)
	}
	e.beacon.Set(endRound)
	if err := e.release(e.holders[0], nil); !errors.Is(err, ErrTooLate) {
		t.Fatalf("at the end round: %v", err)
	}
	e.beacon.Set(unlockRound)
	if err := e.release(e.holders[0], nil); err != nil {
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
	ch, _ := e.c.Challenge()
	if err := e.c.Submit(context.Background(), h.passkey.PublicKey(), ch, []byte("junk")); !errors.Is(err, ErrBadRelease) {
		t.Errorf("junk: %v", err)
	}
	// A message sealed for another purpose.
	ch, _ = e.c.Challenge()
	msg, _ = hashing.ShareRelease(e.exam, ch)
	plain, _ = EncodeRelease(h.share, h.passkey.Sign(t, msg))
	wrongPurpose, _ := encryption.Seal(encryption.PurposeQuestion, e.keys.EncryptionPublicKey(), e.exam, plain)
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
	ch, _ = e.c.Challenge()
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

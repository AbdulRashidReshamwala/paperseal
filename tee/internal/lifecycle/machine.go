// Package lifecycle is the TEE's state machine from spec/api.md "TEE Lifecycle".
// It runs each stage by itself, with no board calls: Onboard, Submit, Lock,
// Build and Distribute, then Unlock. The only things it reads from outside are
// the chain, drand and storage, and each is checked before it is used.
package lifecycle

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"paperseal/tee/internal/approvedlist"
	"paperseal/tee/internal/attestation"
	"paperseal/tee/internal/bank"
	"paperseal/tee/internal/build"
	"paperseal/tee/internal/chainread"
	"paperseal/tee/internal/challenge"
	"paperseal/tee/internal/criteria"
	"paperseal/tee/internal/encryption"
	"paperseal/tee/internal/hashing"
	"paperseal/tee/internal/lock"
	"paperseal/tee/internal/outbox"
	"paperseal/tee/internal/registration"
	"paperseal/tee/internal/release"
	"paperseal/tee/internal/settings"
	"paperseal/tee/internal/spec"
	"paperseal/tee/internal/split"
	"paperseal/tee/internal/storage"
	"paperseal/tee/internal/timelock"
)

// Stage is a value of `stage` in GET /v1/status.
type Stage string

// The stages, in order. Failed is terminal and can follow any of them.
const (
	StageOnboard    Stage = "onboard"
	StageSubmit     Stage = "submit"
	StageLock       Stage = "lock"
	StageBuild      Stage = "build"
	StageDistribute Stage = "distribute"
	StageUnlock     Stage = "unlock"
	StageReleased   Stage = "released"
	StageFailed     Stage = "failed"
)

// Config is everything the machine needs from outside.
type Config struct {
	Exam   settings.Exam
	Keys   *attestation.Keys
	Tokens attestation.TokenSource
	// Verifier checks the Build instance's published token on a fresh Unlock
	// instance. Nil means that start is refused, never skipped.
	Verifier *attestation.Verifier
	Chain    chainread.Source
	Beacon   timelock.Beacon
	Sealer   timelock.Sealer
	Store    storage.Store
	// Now is for challenge expiry and the lock-round cache only. A nil Now uses
	// the system clock. drand is the clock for every decision that matters.
	Now func() time.Time
}

// fatal marks an error that no retry can fix, so the stage becomes failed.
type fatal struct{ err error }

func (f fatal) Error() string { return f.err.Error() }
func (f fatal) Unwrap() error { return f.err }

func fail(format string, a ...any) error { return fatal{fmt.Errorf(format, a...)} }

// Machine is the lifecycle. Its methods are safe for concurrent use.
type Machine struct {
	cfg Config
	now func() time.Time

	registerChallenges *challenge.Store
	questionChallenges *challenge.Store
	releaseChallenges  *challenge.Store
	registrations      *registration.Store
	outbox             *outbox.Memory
	bank               *bank.Bank

	stepMu sync.Mutex // Serialises Step.

	mu         sync.RWMutex
	stage      Stage
	failure    error
	criteria   *criteria.Criteria
	list       *verifiedList
	setters    map[string]bool // Passkey public keys of setters.
	bankSize   int
	questions  []bank.Question // Held between Lock and Build only.
	pending    *pending
	collector  *release.Collector
	lockCached time.Time // When the lock round was last seen unpublished.
}

// verifiedList is the approved list after every check.
type verifiedList struct {
	entries   []approvedlist.Entry
	raw       []byte
	hash      [32]byte
	signature [64]byte
}

// New returns a Machine at Onboard.
func New(cfg Config) *Machine {
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	return &Machine{
		cfg: cfg, now: now,
		registerChallenges: challenge.New(now),
		questionChallenges: challenge.New(now),
		releaseChallenges:  challenge.New(now),
		registrations:      &registration.Store{},
		outbox:             &outbox.Memory{},
		bank:               bank.New(),
		stage:              StageOnboard,
	}
}

// Stage returns the current stage.
func (m *Machine) Stage() Stage {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.stage
}

// Failure returns why the machine failed, or nil.
func (m *Machine) Failure() error {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.failure
}

func (m *Machine) setStage(s Stage) {
	m.mu.Lock()
	m.stage = s
	m.mu.Unlock()
	slog.Info("stage", "stage", string(s))
}

func (m *Machine) markFailed(err error) {
	m.mu.Lock()
	m.stage, m.failure = StageFailed, err
	m.mu.Unlock()
	slog.Error("stage failed", "err", err)
}

// Run steps until ctx ends or the machine reaches a terminal stage.
func (m *Machine) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if err := m.Step(ctx); err != nil && ctx.Err() == nil {
			slog.Warn("step", "stage", string(m.Stage()), "err", err)
		}
		if s := m.Stage(); s == StageFailed || s == StageReleased {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Step makes one attempt to advance the current stage. It returns a retryable
// error, which the next Step tries again. An error that no retry can fix moves
// the machine to failed instead.
func (m *Machine) Step(ctx context.Context) error {
	m.stepMu.Lock()
	defer m.stepMu.Unlock()
	var err error
	switch m.Stage() {
	case StageOnboard:
		err = m.stepOnboard(ctx)
	case StageSubmit:
		err = m.stepSubmit(ctx)
	case StageLock:
		err = m.stepLock()
	case StageBuild:
		err = m.stepBuild(ctx)
	case StageDistribute:
		err = m.stepDistribute(ctx)
	case StageUnlock:
		err = m.stepUnlock(ctx)
	default:
		return nil
	}
	var f fatal
	if errors.As(err, &f) {
		m.markFailed(f.err)
		return nil
	}
	return err
}

// stepOnboard loads the criteria, then waits for the approved list. If the
// chain already holds a Build, this is a fresh instance and it starts Unlock.
func (m *Machine) stepOnboard(ctx context.Context) error {
	if err := m.loadCriteria(ctx); err != nil {
		return err
	}
	m.mu.RLock()
	haveCriteria := m.criteria != nil
	m.mu.RUnlock()
	if !haveCriteria {
		return nil // The exam isn't on-chain yet.
	}
	list, err := m.cfg.Chain.ApprovedList(ctx)
	if errors.Is(err, chainread.ErrNotPosted) {
		return nil
	}
	if err != nil {
		return m.classify(err)
	}
	built, err := m.cfg.Chain.Build(ctx)
	switch {
	case err == nil:
		return m.startFreshUnlock(ctx, list, built)
	case !errors.Is(err, chainread.ErrNotPosted):
		return m.classify(err)
	}

	// No registration may arrive after the check.
	m.registrations.Close()
	entries, err := approvedlist.Decode(list.Entries)
	if err != nil {
		return fail("the approved list is invalid: %w", err)
	}
	if err := approvedlist.CheckRegistered(entries, m.registrations); err != nil {
		return fail("the approved list has an entry that was not verified: %w", err)
	}
	if err := m.acceptList(entries, list); err != nil {
		return err
	}
	m.setStage(StageSubmit)
	return nil
}

// acceptList signs the list and moves on. It is shared by both Onboard paths.
func (m *Machine) acceptList(entries []approvedlist.Entry, list chainread.List) error {
	msg, err := hashing.ApprovedList(m.cfg.Exam.ExamID, list.Entries)
	if err != nil {
		return err
	}
	if msg.Sum() != list.Hash {
		return fail("the approved list hash differs from the chain")
	}
	sig, err := m.cfg.Keys.Sign(msg)
	if err != nil {
		return err
	}
	setters := map[string]bool{}
	for _, e := range entries {
		if e.Role == approvedlist.RoleSetter {
			setters[string(e.PasskeyPublicKey)] = true
		}
	}
	m.mu.Lock()
	m.list = &verifiedList{entries: entries, raw: bytes.Clone(list.Entries), hash: list.Hash, signature: sig}
	m.setters = setters
	m.mu.Unlock()
	return nil
}

// classify treats chain errors as retryable, except those that show the chain
// holds a different exam than the attested settings.
func (m *Machine) classify(err error) error {
	if errors.Is(err, chainread.ErrWrongExam) {
		return fail("%w", err)
	}
	return err
}

// loadCriteria reads the criteria from the chain once and checks them against
// the attested criteriaHash.
func (m *Machine) loadCriteria(ctx context.Context) error {
	m.mu.RLock()
	have := m.criteria != nil
	m.mu.RUnlock()
	if have {
		return nil
	}
	raw, err := m.cfg.Chain.Criteria(ctx)
	if err != nil {
		if errors.Is(err, chainread.ErrNotPosted) {
			return nil // The exam isn't created yet. Wait.
		}
		return m.classify(err)
	}
	msg, err := hashing.Criteria(raw)
	if err != nil {
		return err
	}
	if msg.Sum() != m.cfg.Exam.CriteriaHash {
		return fail("on-chain criteria do not match the attested criteriaHash")
	}
	c, err := criteria.Decode(raw)
	if err != nil {
		return fail("criteria: %w", err)
	}
	m.mu.Lock()
	m.criteria = &c
	m.mu.Unlock()
	return nil
}

func (m *Machine) stepSubmit(ctx context.Context) error {
	_, err := m.cfg.Beacon.Randomness(ctx, m.cfg.Exam.LockRound)
	if errors.Is(err, timelock.ErrNotPublished) {
		return nil
	}
	if err != nil {
		return err
	}
	// From here nothing is accepted, even before Lock has run.
	m.mu.Lock()
	m.questions = m.bank.Close()
	m.bankSize = len(m.questions)
	m.mu.Unlock()
	m.setStage(StageLock)
	return nil
}

// stepLock checks the bank. A bank that fails ends the exam.
func (m *Machine) stepLock() error {
	m.mu.RLock()
	qs, c := m.questions, *m.criteria
	m.mu.RUnlock()
	if _, err := lock.Check(qs, c); err != nil {
		return fail("lock: %w", err)
	}
	m.setStage(StageBuild)
	return nil
}

// pending holds Build's output between Build and the end of Distribute. K,
// K_pub, K_priv and the seed are gone by the time it exists: it holds only what
// is published.
type pending struct {
	files    []file
	token    string
	fields   hashing.BuildFields
	holders  []release.Holder
	centres  [][]byte
	selected uint32
}

type file struct {
	name string // Relative to the exam folder.
	data []byte
	meta storage.ManifestFile
}

// stepBuild runs Build and Split. It generates the seed after Lock, picks the
// questions, encrypts the paper, splits K, timelocks K_pub and encrypts each
// share to its holder.
func (m *Machine) stepBuild(ctx context.Context) error {
	m.mu.RLock()
	qs, c, list := m.questions, *m.criteria, m.list
	m.mu.RUnlock()
	exam := m.cfg.Exam

	paper, err := build.Build(exam.ExamID, c, qs)
	if err != nil {
		return fail("build: %w", err)
	}
	kPub, kPriv, err := split.SplitKey(paper.K)
	if err != nil {
		return fail("split: %w", err)
	}
	shares, err := split.SplitShares(kPriv)
	if err != nil {
		return fail("split: %w", err)
	}
	wipe(paper.K, kPriv)
	paper.K = nil

	locked, err := m.cfg.Sealer.Seal(ctx, exam.UnlockRound, kPub)
	wipe(kPub)
	if err != nil {
		wipe(shares...)
		return err // The sealer may fail for a reason that passes.
	}

	p := &pending{selected: paper.Selected}
	add := func(name string, data []byte, recipient, shareHash string) {
		sum := sha256.Sum256(data)
		p.files = append(p.files, file{name, data, storage.ManifestFile{
			Name: name, SHA256: storage.Hex(sum[:]), Recipient: recipient, ShareHash: shareHash,
		}})
	}
	add("paper.bin", paper.EncryptedPaper, "", "")
	add("key-pub.tlock", locked, "", "")

	var holders []release.Holder
	var centres [][]byte
	next := 0
	for _, e := range list.entries {
		if e.Role == approvedlist.RoleCentreHolder || e.Role == approvedlist.RoleCentre {
			centres = append(centres, e.DerivedPublicKey)
		}
		if e.Role != approvedlist.RoleNeutral && e.Role != approvedlist.RoleCentreHolder {
			continue
		}
		if next >= len(shares) {
			wipe(shares...)
			return fail("more key holders than shares")
		}
		share := shares[next]
		next++
		hm, err := hashing.ShareHash(share)
		if err != nil {
			return err
		}
		sh := hm.Sum()
		framed, err := encryption.Seal(encryption.PurposeShare, e.DerivedPublicKey, exam.ExamID, share)
		if err != nil {
			wipe(shares...)
			return fail("encrypt share: %w", err)
		}
		add("shares/"+storage.Hex(e.DerivedPublicKey)+".bin", framed, storage.Hex(e.DerivedPublicKey), storage.Hex(sh[:]))
		holders = append(holders, release.Holder{PasskeyPublicKey: e.PasskeyPublicKey, ShareHash: sh})
	}
	wipe(shares...)
	if next != spec.C.Threshold.Holders {
		return fail("%d key holders, need %d", next, spec.C.Threshold.Holders)
	}
	p.holders, p.centres = holders, centres
	p.fields = hashing.BuildFields{
		ExamID: exam.ExamID, ApprovedListHash: list.hash, PaperHash: paper.PaperHash,
		SaltedPaperHash: paper.SaltedPaperHash, Selected: paper.Selected, BankSize: paper.BankSize,
		CriteriaHash: exam.CriteriaHash,
	}
	m.mu.Lock()
	m.pending = p
	m.questions = nil // The plaintext bank is gone once the paper is built.
	m.mu.Unlock()
	m.setStage(StageDistribute)
	return nil
}

func wipe(bs ...[]byte) {
	for _, b := range bs {
		for i := range b {
			b[i] = 0
		}
	}
}

// stepDistribute writes the files, then the manifest last, then queues the
// signed Build. The Build exists only after every write succeeded, so a crash
// can't leave a committed paper that nobody can open. Every write is repeatable.
func (m *Machine) stepDistribute(ctx context.Context) error {
	m.mu.RLock()
	p := m.pending
	m.mu.RUnlock()
	exam := m.cfg.Exam

	if p.token == "" {
		nonce, err := attestation.Nonce(m.cfg.Keys.PublicKey(), exam.ExamID)
		if err != nil {
			return err
		}
		tok, err := m.cfg.Tokens.Token(ctx, attestation.TokenPKI, spec.C.Attestation.Audience, nonce)
		if errors.Is(err, attestation.ErrUnattested) {
			// Not Confidential Space. The manifest must list a token, and none
			// can be made, so the Build can't be committed.
			return fail("distribute: %w", err)
		}
		if err != nil {
			return err
		}
		p.token = tok.Raw
		sum := sha256.Sum256([]byte(tok.Raw))
		p.files = append(p.files, file{"token.jwt", []byte(tok.Raw), storage.ManifestFile{Name: "token.jwt", SHA256: storage.Hex(sum[:])}})
	}

	prefix := storage.Prefix(exam.ExamID)
	var metas []storage.ManifestFile
	for _, f := range p.files {
		if err := m.cfg.Store.Put(ctx, prefix+f.name, f.data); err != nil {
			return err
		}
		metas = append(metas, f.meta)
	}
	manifest, err := storage.NewManifest(exam.ExamID, metas).Marshal()
	if err != nil {
		return err
	}
	if err := m.cfg.Store.Put(ctx, prefix+storage.ManifestName, manifest); err != nil {
		return err
	}

	fields := p.fields
	fields.StorageManifestHash = storage.Hash(manifest)
	sig, err := m.cfg.Keys.Sign(hashing.Build(fields))
	if err != nil {
		return err
	}
	if err := m.outbox.Put(ctx, outbox.Message{
		Kind: outbox.KindBuild, ExamID: fields.ExamID, ApprovedListHash: fields.ApprovedListHash,
		PaperHash: fields.PaperHash, StorageManifestHash: fields.StorageManifestHash,
		SaltedPaperHash: fields.SaltedPaperHash, Selected: fields.Selected, BankSize: fields.BankSize,
		CriteriaHash: fields.CriteriaHash, TEESignature: sig, InstancePublicKey: m.cfg.Keys.PublicKey(),
	}); err != nil && !errors.Is(err, outbox.ErrAlreadyQueued) {
		return err
	}
	m.startUnlock(release.Facts{
		ExamID: exam.ExamID, UnlockRound: exam.UnlockRound, EndRound: exam.EndRound,
		Holders: p.holders, Centres: p.centres,
	})
	return nil
}

func (m *Machine) startUnlock(f release.Facts) {
	c := release.New(f, release.Deps{
		Opener: m.cfg.Keys, Signer: m.cfg.Keys, Beacon: m.cfg.Beacon, Sealer: m.cfg.Sealer,
		Store: m.cfg.Store, Challenges: m.releaseChallenges, Tokens: m.cfg.Tokens,
	})
	m.mu.Lock()
	m.collector = c
	m.pending = nil
	m.mu.Unlock()
	m.setStage(StageUnlock)
}

func (m *Machine) stepUnlock(ctx context.Context) error {
	m.mu.RLock()
	c := m.collector
	m.mu.RUnlock()
	if err := c.Step(ctx); err != nil {
		if errors.Is(err, attestation.ErrUnattested) {
			return fail("unlock: %w", err)
		}
		return err
	}
	if c.Done() {
		m.setStage(StageReleased)
	}
	return nil
}

package lifecycle_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"paperseal/tee/internal/api"
	"paperseal/tee/internal/attestation"
	"paperseal/tee/internal/build"
	"paperseal/tee/internal/encryption"
	"paperseal/tee/internal/hashing"
	"paperseal/tee/internal/lifecycle"
	"paperseal/tee/internal/release"
	"paperseal/tee/internal/spec"
	"paperseal/tee/internal/split"
	"paperseal/tee/internal/storage"
)

// onboardAndSubmit runs the world up to Submit with 20 questions in the bank.
func onboardAndSubmit(t *testing.T, w *world, m *lifecycle.Machine, c client, keys *attestation.Keys) {
	t.Helper()
	ctx := context.Background()
	// Nothing happens until the exam and then the list are on-chain.
	if err := m.Step(ctx); err != nil || m.Stage() != lifecycle.StageOnboard {
		t.Fatalf("before the exam exists: %v %s", err, m.Stage())
	}
	w.chain.mu.Lock()
	w.chain.created = true
	w.chain.mu.Unlock()
	if err := m.Step(ctx); err != nil || m.Stage() != lifecycle.StageOnboard {
		t.Fatalf("before the list: %v %s", err, m.Stage())
	}
	w.registerAll(c)
	w.postList(w.entries()...)
	stepUntil(t, m, lifecycle.StageSubmit)

	st := c.status()
	if st.ApprovedList == nil || st.Stage != "submit" {
		t.Fatalf("status %+v", st)
	}
	msg, _ := hashing.ApprovedList(w.exam.ExamID, st.ApprovedList.Entries)
	var sig [64]byte
	copy(sig[:], st.ApprovedList.TEESignature)
	if sum := msg.Sum(); !bytes.Equal(sum[:], st.ApprovedList.Hash) {
		t.Fatal("status hash is not the approvedList message hash")
	}
	if err := attestation.Verify(keys.PublicKey(), msg, sig); err != nil {
		t.Fatalf("list signature: %v", err)
	}

	enc := c.attestation().EncryptionPublicKey
	for i, s := range w.setters {
		for q := 0; q < 3; q++ {
			code, why, resp := c.submit(s, questionText(i, "algebra", q), enc, w.exam.ExamID)
			if code != http.StatusOK {
				t.Fatalf("submit: %d %s", code, why)
			}
			// The receipt is signed by the instance key over the question hash.
			rm, _ := hashing.QuestionReceipt(w.exam.ExamID, s.passkey.PublicKey(), [32]byte(resp.QuestionHash))
			var rs [64]byte
			copy(rs[:], resp.TEESignature)
			if err := attestation.Verify(keys.PublicKey(), rm, rs); err != nil {
				t.Fatalf("receipt: %v", err)
			}
		}
		for q := 0; q < 2; q++ {
			if code, why, _ := c.submit(s, questionText(i, "geometry", q), enc, w.exam.ExamID); code != http.StatusOK {
				t.Fatalf("submit: %d %s", code, why)
			}
		}
	}
	if n := c.status().QuestionCount; n != 20 {
		t.Fatalf("question count %d", n)
	}
}

// lockAndBuild publishes the lock round and runs to Unlock.
func lockAndBuild(t *testing.T, w *world, m *lifecycle.Machine) {
	t.Helper()
	w.beacon.Set(lockRound)
	stepUntil(t, m, lifecycle.StageUnlock)
}

func TestFullLifecycle(t *testing.T) {
	w := newWorld(t)
	m, keys, h := w.machine()
	c := client{t, h}
	onboardAndSubmit(t, w, m, c, keys)
	ctx := context.Background()
	enc := c.attestation().EncryptionPublicKey

	// Submissions are checked.
	if code, why, _ := c.submit(w.holders[0], questionText(0, "algebra", 9), enc, w.exam.ExamID); code != http.StatusForbidden || why != "not_on_list" {
		t.Errorf("non-setter: %d %s", code, why)
	}
	if code, why, _ := c.submit(w.setters[0], questionText(0, "algebra", 0), enc, w.exam.ExamID); code != http.StatusConflict || why != "duplicate_question" {
		t.Errorf("duplicate: %d %s", code, why)
	}
	if code, why, _ := c.submit(w.setters[0], []byte(`{"topic":"history","text":"x"}`), enc, w.exam.ExamID); code != http.StatusBadRequest || why != "unknown_topic" {
		t.Errorf("topic: %d %s", code, why)
	}
	if code, why, _ := c.submit(w.setters[0], []byte(`{"topic":"algebra"}`), enc, w.exam.ExamID); code != http.StatusBadRequest || why != "invalid_question" {
		t.Errorf("format: %d %s", code, why)
	}
	if n := c.status().QuestionCount; n != 20 {
		t.Fatalf("bad submissions were counted: %d", n)
	}

	// Registration is closed once the list was read.
	if code, why := c.do("POST", "/v1/register/challenge", map[string]any{}, nil); code != http.StatusConflict || why != "wrong_stage" {
		t.Errorf("late registration challenge: %d %s", code, why)
	}

	lockAndBuild(t, w, m)
	if code, why, _ := c.submit(w.setters[0], questionText(0, "algebra", 7), enc, w.exam.ExamID); code != http.StatusConflict {
		t.Errorf("question after Lock: %d %s", code, why)
	}
	st := c.status()
	if st.Stage != "unlock" || st.QuestionCount != 20 {
		t.Fatalf("status %+v", st)
	}

	// The Build waits in the outbox, signed by the instance key.
	var ob api.OutboxResponse
	c.mustOK("GET", "/v1/outbox", nil, &ob)
	if len(ob.Messages) != 1 || ob.Messages[0].Kind != "build" {
		t.Fatalf("outbox %+v", ob)
	}
	msg := ob.Messages[0]
	f := msg.Fields
	if f.Selected != 5 || f.BankSize != 20 {
		t.Fatalf("selected %d of %d", f.Selected, f.BankSize)
	}
	fields := hashing.BuildFields{
		ExamID: w.exam.ExamID, ApprovedListHash: [32]byte(f.ApprovedListHash), PaperHash: [32]byte(f.PaperHash),
		StorageManifestHash: [32]byte(f.StorageManifestHash), SaltedPaperHash: [32]byte(f.SaltedPaperHash),
		Selected: f.Selected, BankSize: f.BankSize, CriteriaHash: [32]byte(f.CriteriaHash),
	}
	var sig [64]byte
	copy(sig[:], msg.TEESignature)
	if err := attestation.Verify(msg.InstancePublicKey, hashing.Build(fields), sig); err != nil {
		t.Fatalf("build signature: %v", err)
	}
	if !bytes.Equal(msg.InstancePublicKey, keys.PublicKey()) {
		t.Fatal("build is signed by another key")
	}
	if fields.ApprovedListHash != [32]byte(st.ApprovedList.Hash) || fields.CriteriaHash != w.exam.CriteriaHash {
		t.Fatal("build does not commit to the list and criteria")
	}

	// The files are on storage and the manifest covers every one.
	prefix := storage.Prefix(w.exam.ExamID)
	manifestBytes, err := w.store.Get(ctx, prefix+"manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	if storage.Hash(manifestBytes) != fields.StorageManifestHash {
		t.Fatal("storageManifestHash is not the hash of manifest.json")
	}
	manifest, err := storage.ParseManifest(manifestBytes)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Files) != 2+10+1 {
		t.Fatalf("manifest lists %d files", len(manifest.Files))
	}
	for _, mf := range manifest.Files {
		data, err := w.store.Get(ctx, prefix+mf.Name)
		if err != nil {
			t.Fatalf("%s: %v", mf.Name, err)
		}
		if sum := sha256.Sum256(data); storage.Hex(sum[:]) != mf.SHA256 {
			t.Fatalf("%s: hash differs from the manifest", mf.Name)
		}
	}
	paperFile, _ := w.store.Get(ctx, prefix+"paper.bin")
	if sha := sha256.Sum256(paperFile); sha != fields.PaperHash {
		t.Fatal("paperHash")
	}

	// Before the unlock round nothing is released.
	if code, why := c.releaseShare(w, w.holders[0], enc); code != http.StatusTooEarly || why != "too_early" {
		t.Fatalf("early release: %d %s", code, why)
	}
	w.beacon.Set(unlockRound)

	// Seven shares release nothing.
	for _, p := range w.holders[:7] {
		if code, why := c.releaseShare(w, p, enc); code != http.StatusOK {
			t.Fatalf("release: %d %s", code, why)
		}
	}
	st = c.status()
	if len(st.Release.Released) != 7 || st.Release.Required != 8 || st.Stage != "unlock" {
		t.Fatalf("status after 7: %+v", st)
	}
	if !bytes.Equal(st.Release.Released[0], w.holders[0].passkey.PublicKey()) {
		t.Fatal("released lists passkey public keys")
	}
	if _, err := w.store.Get(ctx, prefix+"key-priv.tlock"); !errors.Is(err, storage.ErrNotFound) {
		t.Fatal("K_priv published after 7 shares")
	}
	if _, err := w.store.Get(ctx, prefix+"release-log.json"); !errors.Is(err, storage.ErrNotFound) {
		t.Fatal("release log published after 7 shares")
	}
	var log release.Log
	c.mustOK("GET", "/v1/release/log", nil, &log)
	if len(log.Entries) != 7 {
		t.Fatalf("log has %d entries", len(log.Entries))
	}

	// The eighth does.
	if code, why := c.releaseShare(w, w.holders[7], enc); code != http.StatusOK {
		t.Fatalf("eighth release: %d %s", code, why)
	}
	stepUntil(t, m, lifecycle.StageReleased)

	// A centre staff member recovers K_priv with their derived key, takes K_pub
	// from drand at the unlock round, and decrypts the paper.
	centre := w.centre
	kPrivFile, err := w.store.Get(ctx, prefix+"key-priv/"+storage.Hex(centre.derivedKey())+".bin")
	if err != nil {
		t.Fatal(err)
	}
	kPriv, err := centre.derived.Open(encryption.PurposeKeyPriv, w.exam.ExamID, kPrivFile)
	if err != nil {
		t.Fatal(err)
	}
	locked, _ := w.store.Get(ctx, prefix+"key-pub.tlock")
	if _, err := w.drand.OpenAt(t, locked, unlockRound-1); err == nil {
		t.Fatal("K_pub opened before the unlock round")
	}
	kPub, err := w.drand.OpenAt(t, locked, unlockRound)
	if err != nil {
		t.Fatal(err)
	}
	k, err := split.CombineKey(kPub, kPriv)
	if err != nil {
		t.Fatal(err)
	}
	seed, paper, err := build.OpenPaper(k, w.exam.ExamID, paperFile)
	if err != nil {
		t.Fatalf("the paper did not decrypt: %v", err)
	}
	salted, _ := hashing.SaltedPaper(seed, paper)
	if salted.Sum() != fields.SaltedPaperHash {
		t.Fatal("saltedPaperHash does not match the Build")
	}
	var doc build.PaperDoc
	if err := json.Unmarshal(paper, &doc); err != nil || len(doc.Questions) != 5 {
		t.Fatalf("paper: %s", paper)
	}
	perTopic := map[string]int{}
	for _, q := range doc.Questions {
		perTopic[q.Topic]++
	}
	if perTopic["algebra"] != 3 || perTopic["geometry"] != 2 {
		t.Fatalf("per topic %v", perTopic)
	}
	// At the end round anyone opens K_priv and so the paper, with no holder.
	endCopy, _ := w.store.Get(ctx, prefix+"key-priv.tlock")
	if _, err := w.drand.OpenAt(t, endCopy, endRound-1); err == nil {
		t.Fatal("K_priv copy opened before the end round")
	}
	pub, err := w.drand.OpenAt(t, endCopy, endRound)
	if err != nil || !bytes.Equal(pub, kPriv) {
		t.Fatalf("end-round copy: %v", err)
	}

	// The signed log covers the eight, and nothing more is taken.
	c.mustOK("GET", "/v1/release/log", nil, &log)
	if len(log.Entries) != 8 {
		t.Fatalf("final log has %d entries", len(log.Entries))
	}
	if code, why := c.releaseShare(w, w.holders[8], enc); code != http.StatusConflict {
		t.Errorf("share after release: %d %s", code, why)
	}
}

// With only seven holders present, nothing is released however long they wait.
func TestSevenSharesReleaseNothingEndToEnd(t *testing.T) {
	w := newWorld(t)
	m, keys, h := w.machine()
	c := client{t, h}
	onboardAndSubmit(t, w, m, c, keys)
	lockAndBuild(t, w, m)
	enc := c.attestation().EncryptionPublicKey
	w.beacon.Set(unlockRound + 10)
	for _, p := range w.holders[3:10] { // Seven centre holders, no neutral party.
		if code, why := c.releaseShare(w, p, enc); code != http.StatusOK {
			t.Fatalf("release: %d %s", code, why)
		}
	}
	for i := 0; i < 3; i++ {
		if err := m.Step(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if m.Stage() != lifecycle.StageUnlock {
		t.Fatalf("stage %s", m.Stage())
	}
	prefix := storage.Prefix(w.exam.ExamID)
	for _, name := range []string{"key-priv.tlock", "release-log.json"} {
		if _, err := w.store.Get(context.Background(), prefix+name); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("%s exists after 7 shares", name)
		}
	}
	// A neutral party's share is what makes eight.
	if code, why := c.releaseShare(w, w.holders[0], enc); code != http.StatusOK {
		t.Fatalf("release: %d %s", code, why)
	}
	stepUntil(t, m, lifecycle.StageReleased)
}

func TestLateRoundIsRefused(t *testing.T) {
	w := newWorld(t)
	m, keys, h := w.machine()
	c := client{t, h}
	onboardAndSubmit(t, w, m, c, keys)
	lockAndBuild(t, w, m)
	enc := c.attestation().EncryptionPublicKey
	// The end round is published: the paper is public, so releases are refused.
	w.beacon.Set(endRound)
	if code, why := c.releaseShare(w, w.holders[0], enc); code != http.StatusConflict || why != "too_late" {
		t.Fatalf("late release: %d %s", code, why)
	}
	if len(c.status().Release.Released) != 0 {
		t.Fatal("a late release was counted")
	}
}

// A drand that can't prove its round is never believed.
func TestUnverifiableBeaconAcceptsNothing(t *testing.T) {
	w := newWorld(t)
	var bad badBeacon
	m, keys, h := w.machine(func(cfg *lifecycle.Config) { cfg.Beacon = &toggleBeacon{inner: w.beacon, bad: &bad} })
	c := client{t, h}
	onboardAndSubmit(t, w, m, c, keys)
	lockAndBuild(t, w, m)
	enc := c.attestation().EncryptionPublicKey
	w.beacon.Set(unlockRound)
	bad.on = true
	if code, _ := c.releaseShare(w, w.holders[0], enc); code != http.StatusInternalServerError {
		t.Fatalf("share accepted on a round that doesn't verify: %d", code)
	}
	if len(c.status().Release.Released) != 0 {
		t.Fatal("counted")
	}
}

// The Build can't be committed outside Confidential Space, because no token can
// be made: the machine fails instead of faking one.
func TestUnattestedInstanceCannotBuild(t *testing.T) {
	w := newWorld(t)
	m, keys, h := w.machine(func(cfg *lifecycle.Config) {
		cfg.Tokens = &unattested{}
	})
	c := client{t, h}
	onboardAndSubmit(t, w, m, c, keys)
	w.beacon.Set(lockRound)
	for i := 0; i < 6 && m.Stage() != lifecycle.StageFailed; i++ {
		m.Step(context.Background())
	}
	if m.Stage() != lifecycle.StageFailed || !errors.Is(m.Failure(), attestation.ErrUnattested) {
		t.Fatalf("stage %s, failure %v", m.Stage(), m.Failure())
	}
	var ob api.OutboxResponse
	c.mustOK("GET", "/v1/outbox", nil, &ob)
	if len(ob.Messages) != 0 {
		t.Fatal("a Build was queued without a token")
	}
	// And the attestation route says so, with no token.
	a := c.attestation()
	if a.Token != "" || a.Attested {
		t.Fatalf("attestation %+v", a)
	}
	if len(a.InstancePublicKey) != 65 || len(a.EncryptionPublicKey) != 65 || len(a.InstanceKeySignature) != 64 {
		t.Fatal("keys missing from an unattested instance")
	}
	// The instance key signature verifies.
	im, _ := hashing.InstanceKey(w.exam.ExamID, a.EncryptionPublicKey)
	var sig [64]byte
	copy(sig[:], a.InstanceKeySignature)
	if err := attestation.Verify(a.InstancePublicKey, im, sig); err != nil {
		t.Fatal(err)
	}
}

func TestLockFailureEndsTheExam(t *testing.T) {
	w := newWorld(t)
	m, keys, h := w.machine()
	c := client{t, h}
	ctx := context.Background()
	w.chain.created = true
	w.registerAll(c)
	w.postList(w.entries()...)
	stepUntil(t, m, lifecycle.StageSubmit)
	enc := c.attestation().EncryptionPublicKey
	_ = keys
	// One setter fills the algebra bank: too big a share, and too small a bank.
	for q := 0; q < 6; q++ {
		if code, why, _ := c.submit(w.setters[0], questionText(0, "algebra", q), enc, w.exam.ExamID); code != http.StatusOK {
			t.Fatalf("%d %s", code, why)
		}
	}
	w.beacon.Set(lockRound)
	for i := 0; i < 3; i++ {
		m.Step(ctx)
	}
	if m.Stage() != lifecycle.StageFailed {
		t.Fatalf("stage %s", m.Stage())
	}
	if c.status().Stage != "failed" {
		t.Fatal("status does not say failed")
	}
	var ob api.OutboxResponse
	c.mustOK("GET", "/v1/outbox", nil, &ob)
	if len(ob.Messages) != 0 {
		t.Fatal("a Build exists for a failed bank")
	}
}

func TestUnverifiedListEntryFails(t *testing.T) {
	w := newWorld(t)
	m, _, h := w.machine()
	c := client{t, h}
	w.chain.created = true
	// Register everyone but one setter.
	for _, p := range w.all[1:] {
		if code, why := c.register(p, nil); code != http.StatusOK {
			t.Fatalf("%d %s", code, why)
		}
	}
	w.postList(w.entries()...)
	m.Step(context.Background())
	if m.Stage() != lifecycle.StageFailed {
		t.Fatalf("stage %s, want failed for an entry that never registered", m.Stage())
	}
}

func TestListWithWrongCriteriaHashFails(t *testing.T) {
	w := newWorld(t)
	w.chain.criteria = append([]byte(nil), w.chain.criteria...)
	w.chain.criteria[len(w.chain.criteria)-1] ^= 1
	w.chain.created = true
	m, _, _ := w.machine()
	m.Step(context.Background())
	if m.Stage() != lifecycle.StageFailed {
		t.Fatalf("stage %s, want failed for criteria that differ from criteriaHash", m.Stage())
	}
}

func TestRegistrationChecks(t *testing.T) {
	w := newWorld(t)
	_, _, h := w.machine()
	c := client{t, h}
	p := w.holders[0]
	cases := map[string]func(*api.RegisterRequest){
		"wrong owner": func(r *api.RegisterRequest) { r.Owner = "someone else" },
		"wrong derived key": func(r *api.RegisterRequest) {
			r.DerivedPublicKey = w.holders[1].derivedKey()
		},
		"not a point": func(r *api.RegisterRequest) { r.DerivedPublicKey = []byte{4, 1, 2} },
		"empty owner": func(r *api.RegisterRequest) { r.Owner = "" },
		"unknown challenge": func(r *api.RegisterRequest) {
			r.Challenge = bytes.Repeat([]byte{9}, 32)
		},
		"bad signature": func(r *api.RegisterRequest) { r.Signature = append([]byte(nil), r.Signature...); r.Signature[5] ^= 1 },
	}
	for name, mutate := range cases {
		if code, why := c.register(p, mutate); code != http.StatusBadRequest {
			t.Errorf("%s: %d %s", name, code, why)
		}
	}
	// Nothing is listed until something is verified.
	var none api.RegistrationsResponse
	c.mustOK("GET", "/v1/registrations", nil, &none)
	if none.Registrations == nil || len(none.Registrations) != 0 {
		t.Fatalf("empty list: %+v", none)
	}
	// A synced passkey is refused.
	synced := *p.passkey
	synced.Flags |= webauthnBackup
	if code, why := c.register(&person{owner: p.owner, role: p.role, passkey: &synced, derived: p.derived}, nil); code != http.StatusBadRequest {
		t.Errorf("synced passkey: %d %s", code, why)
	}
	if code, why := c.register(p, nil); code != http.StatusOK {
		t.Fatalf("valid: %d %s", code, why)
	}
	var listed api.RegistrationsResponse
	c.mustOK("GET", "/v1/registrations", nil, &listed)
	if len(listed.Registrations) != 1 || listed.Registrations[0].Owner != p.owner ||
		!bytes.Equal(listed.Registrations[0].PasskeyPublicKey, p.passkey.PublicKey()) ||
		!bytes.Equal(listed.Registrations[0].DerivedPublicKey, p.derivedKey()) {
		t.Fatalf("registrations: %+v", listed)
	}
	// Registering the same passkey again is refused.
	if code, why := c.register(p, nil); code != http.StatusConflict || why != "already_registered" {
		t.Errorf("duplicate: %d %s", code, why)
	}
	// A challenge works once.
	var ch api.ChallengeResponse
	c.mustOK("POST", "/v1/register/challenge", map[string]any{}, &ch)
	msg, _ := hashing.Registration(w.holders[2].derivedKey(), []byte(w.holders[2].owner), ch.Challenge)
	a := w.holders[2].passkey.Sign(t, msg)
	req := api.RegisterRequest{
		Owner: w.holders[2].owner, Challenge: ch.Challenge, PasskeyPublicKey: w.holders[2].passkey.PublicKey(),
		DerivedPublicKey: w.holders[2].derivedKey(), ClientDataJSON: a.ClientDataJSON, Signature: a.Signature, AuthenticatorData: a.AuthenticatorData,
	}
	if code, _ := c.do("POST", "/v1/register", req, nil); code != http.StatusOK {
		t.Fatal("first use failed")
	}
	req.PasskeyPublicKey = w.holders[3].passkey.PublicKey()
	if code, _ := c.do("POST", "/v1/register", req, nil); code != http.StatusBadRequest {
		t.Fatal("a spent challenge was accepted again")
	}
}

func TestQuestionChecks(t *testing.T) {
	w := newWorld(t)
	m, keys, h := w.machine()
	c := client{t, h}
	enc := c.attestation().EncryptionPublicKey

	// Before the list there is no Submit stage.
	if code, why, _ := c.submit(w.setters[0], questionText(0, "algebra", 0), enc, w.exam.ExamID); code != http.StatusConflict || why != "wrong_stage" {
		t.Fatalf("before Submit: %d %s", code, why)
	}
	w.chain.created = true
	w.registerAll(c)
	w.postList(w.entries()...)
	stepUntil(t, m, lifecycle.StageSubmit)
	_ = keys

	setter := w.setters[0]
	good := questionText(0, "algebra", 0)
	// A signature over another ciphertext.
	padded, _ := encryption.Pad(good, spec.C.Padding.QuestionBytes)
	ct, _ := encryption.Seal(encryption.PurposeQuestion, enc, w.exam.ExamID, padded)
	var ch api.ChallengeResponse
	c.mustOK("POST", "/v1/questions/challenge", map[string]any{}, &ch)
	other := sha256.Sum256([]byte("other"))
	msg, _ := hashing.QuestionSubmission(w.exam.ExamID, ch.Challenge, other)
	a := setter.passkey.Sign(t, msg)
	req := api.QuestionRequest{PasskeyPublicKey: setter.passkey.PublicKey(), Ciphertext: ct, Challenge: ch.Challenge,
		Signature: a.Signature, AuthenticatorData: a.AuthenticatorData, ClientDataJSON: a.ClientDataJSON}
	if code, why := c.do("POST", "/v1/questions", req, nil); code != http.StatusBadRequest || why != "invalid_signature" {
		t.Errorf("signature over another ciphertext: %d %s", code, why)
	}
	// Ciphertext sealed to the wrong purpose, and to another exam.
	for name, seal := range map[string]func() []byte{
		"wrong purpose": func() []byte {
			b, _ := encryption.Seal(encryption.PurposeShare, enc, w.exam.ExamID, padded)
			return b
		},
		"wrong exam": func() []byte {
			b, _ := encryption.Seal(encryption.PurposeQuestion, enc, [32]byte{1}, padded)
			return b
		},
		"unpadded": func() []byte {
			b, _ := encryption.Seal(encryption.PurposeQuestion, enc, w.exam.ExamID, good)
			return b
		},
	} {
		ct := seal()
		c.mustOK("POST", "/v1/questions/challenge", map[string]any{}, &ch)
		hash := sha256.Sum256(ct)
		msg, _ := hashing.QuestionSubmission(w.exam.ExamID, ch.Challenge, hash)
		a := setter.passkey.Sign(t, msg)
		code, why := c.do("POST", "/v1/questions", api.QuestionRequest{PasskeyPublicKey: setter.passkey.PublicKey(), Ciphertext: ct,
			Challenge: ch.Challenge, Signature: a.Signature, AuthenticatorData: a.AuthenticatorData, ClientDataJSON: a.ClientDataJSON}, nil)
		if code != http.StatusBadRequest {
			t.Errorf("%s: %d %s", name, code, why)
		}
	}
	if c.status().QuestionCount != 0 {
		t.Fatal("a bad question was counted")
	}
}

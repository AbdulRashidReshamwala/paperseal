package lifecycle_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"paperseal/tee/internal/api"
	"paperseal/tee/internal/attestation"
	"paperseal/tee/internal/build"
	"paperseal/tee/internal/chainread"
	"paperseal/tee/internal/encryption"
	"paperseal/tee/internal/hashing"
	"paperseal/tee/internal/lifecycle"
	"paperseal/tee/internal/split"
	"paperseal/tee/internal/storage"
)

// built runs a world through Build and returns the Build the board would post.
func built(t *testing.T) (*world, chainread.Build, *attestation.Keys) {
	t.Helper()
	w := newWorld(t)
	m, keys, h := w.machine()
	c := client{t, h}
	onboardAndSubmit(t, w, m, c, keys)
	lockAndBuild(t, w, m)
	var ob api.OutboxResponse
	c.mustOK("GET", "/v1/outbox", nil, &ob)
	msg := ob.Messages[0]
	f := msg.Fields
	b := chainread.Build{
		ApprovedListHash: [32]byte(f.ApprovedListHash), PaperHash: [32]byte(f.PaperHash),
		StorageManifestHash: [32]byte(f.StorageManifestHash), SaltedPaperHash: [32]byte(f.SaltedPaperHash),
		Selected: f.Selected, BankSize: f.BankSize, CriteriaHash: [32]byte(f.CriteriaHash), BuiltRound: f.BuiltRound,
		TEESignature: msg.TEESignature, InstancePublicKey: msg.InstancePublicKey,
	}
	return w, b, keys
}

func (w *world) postBuild(b chainread.Build) {
	w.chain.mu.Lock()
	w.chain.build = &b
	w.chain.mu.Unlock()
}

// waitsForBuild steps a fresh instance and checks it neither moves nor fails.
func waitsForBuild(t *testing.T, m *lifecycle.Machine) {
	t.Helper()
	for i := 0; i < 5; i++ {
		if err := m.Step(context.Background()); err != nil {
			t.Fatalf("step: %v", err)
		}
		if m.Stage() != lifecycle.StageOnboard || m.Failure() != nil {
			t.Fatalf("stage %s, failure %v, want it waiting in onboard", m.Stage(), m.Failure())
		}
	}
}

// A read can show the list before the Build. An instance with no registrations
// can't have run Onboard, so it waits for the Build and then starts Unlock.
func TestFreshInstanceSeesTheListFirstAndTheBuildLater(t *testing.T) {
	w, b, _ := built(t)
	m, _, h := w.machine()
	c := client{t, h}
	waitsForBuild(t, m)
	if st := c.status(); st.Stage != "onboard" || st.ApprovedList != nil {
		t.Fatalf("status while waiting %+v", st)
	}

	w.postBuild(b)
	stepUntil(t, m, lifecycle.StageUnlock)
	if st := c.status(); st.ApprovedList == nil || st.QuestionCount != 20 {
		t.Fatalf("status %+v", st)
	}
}

// With no Build, a fresh instance waits for as long as it takes, whatever the
// list says, because the list is only checked against the Build.
func TestFreshInstanceWithNoBuildStaysWaiting(t *testing.T) {
	w := newWorld(t)
	w.chain.created = true
	w.postList(w.entries()...)
	m, _, _ := w.machine()
	waitsForBuild(t, m)

	w.chain.mu.Lock()
	w.chain.list = &chainread.List{Entries: []byte("not an encoded list"), Hash: [32]byte{1}, Block: 2}
	w.chain.mu.Unlock()
	waitsForBuild(t, m)
}

// Nobody can register on a waiting instance to send it into CheckRegistered.
func TestRegistrationCannotFailAWaitingInstance(t *testing.T) {
	w, b, _ := built(t)
	m, _, h := w.machine()
	c := client{t, h}
	waitsForBuild(t, m)
	if code, why := c.register(w.setters[0], nil); code != http.StatusConflict {
		t.Fatalf("register while waiting: %d %s", code, why)
	}
	waitsForBuild(t, m)
	w.postBuild(b)
	stepUntil(t, m, lifecycle.StageUnlock)
}

// A fresh instance shares no state with the one that built the paper. It
// verifies the Build, then runs Unlock, and the paper still opens.
func TestFreshInstanceUnlocks(t *testing.T) {
	w, b, buildKeys := built(t)
	w.postBuild(b)

	m, keys, h := w.machine()
	c := client{t, h}
	stepUntil(t, m, lifecycle.StageUnlock)
	if bytes.Equal(keys.PublicKey(), buildKeys.PublicKey()) {
		t.Fatal("the instances should have different keys")
	}
	if st := c.status(); st.ApprovedList == nil || st.QuestionCount != 20 {
		t.Fatalf("status %+v", st)
	}
	// Nothing registered here.
	var regs api.RegistrationsResponse
	c.mustOK("GET", "/v1/registrations", nil, &regs)
	if len(regs.Registrations) != 0 {
		t.Fatal("a fresh instance holds registrations")
	}

	w.beacon.Set(unlockRound)
	enc := c.attestation().EncryptionPublicKey
	for _, p := range w.holders[:8] {
		if code, why := c.releaseShare(w, p, enc); code != http.StatusOK {
			t.Fatalf("release on the fresh instance: %d %s", code, why)
		}
	}
	stepUntil(t, m, lifecycle.StageReleased)

	ctx := context.Background()
	prefix := storage.Prefix(w.exam.ExamID)
	var log struct {
		InstancePublicKey string `json:"instancePublicKey"`
	}
	body, err := w.store.Get(ctx, prefix+"release-log.json")
	if err != nil {
		t.Fatal(err)
	}
	json.Unmarshal(body, &log)
	if log.InstancePublicKey != storage.Hex(keys.PublicKey()) {
		t.Fatal("the log must name the Unlock instance's key")
	}
	if _, err := w.store.Get(ctx, prefix+"release-token.jwt"); err != nil {
		t.Fatalf("release token: %v", err)
	}

	// The paper opens with the K_priv this instance delivered.
	kFile, _ := w.store.Get(ctx, prefix+"key-priv/"+storage.Hex(w.centre.derivedKey())+".bin")
	kPriv, err := w.centre.derived.Open(encryption.PurposeKeyPriv, w.exam.ExamID, kFile)
	if err != nil {
		t.Fatal(err)
	}
	locked, _ := w.store.Get(ctx, prefix+"key-pub.tlock")
	kPub, err := w.drand.OpenAt(t, locked, unlockRound)
	if err != nil {
		t.Fatal(err)
	}
	k, _ := split.CombineKey(kPub, kPriv)
	paperFile, _ := w.store.Get(ctx, prefix+"paper.bin")
	seed, paper, err := build.OpenPaper(k, w.exam.ExamID, paperFile)
	if err != nil {
		t.Fatalf("paper: %v", err)
	}
	salted, _ := hashing.SaltedPaper(seed, paper)
	if salted.Sum() != b.SaltedPaperHash {
		t.Fatal("saltedPaperHash")
	}
}

// Every failed check leaves the instance refusing shares.
func TestFreshInstanceRefusesAnUnverifiedBuild(t *testing.T) {
	cases := map[string]func(w *world, b *chainread.Build) func(cfg *lifecycle.Config){
		"tampered signature": func(w *world, b *chainread.Build) func(*lifecycle.Config) {
			b.TEESignature = append([]byte(nil), b.TEESignature...)
			b.TEESignature[3] ^= 1
			return nil
		},
		"another list hash": func(w *world, b *chainread.Build) func(*lifecycle.Config) {
			b.ApprovedListHash[0] ^= 1
			return nil
		},
		"another manifest hash": func(w *world, b *chainread.Build) func(*lifecycle.Config) {
			b.StorageManifestHash[0] ^= 1
			return nil
		},
		"another criteria hash": func(w *world, b *chainread.Build) func(*lifecycle.Config) {
			b.CriteriaHash[0] ^= 1
			return nil
		},
		"another built round": func(w *world, b *chainread.Build) func(*lifecycle.Config) {
			b.BuiltRound++
			return nil
		},
		"a key the token does not bind": func(w *world, b *chainread.Build) func(*lifecycle.Config) {
			other, _ := attestation.NewKeys(w.exam.ExamID)
			b.InstancePublicKey = other.PublicKey()
			return nil
		},
		"another image digest on-chain": func(w *world, b *chainread.Build) func(*lifecycle.Config) {
			w.chain.imageDigest[0] ^= 1
			return nil
		},
		"no Google root": func(w *world, b *chainread.Build) func(*lifecycle.Config) {
			return func(cfg *lifecycle.Config) { cfg.Verifier = nil }
		},
		"a token from another PKI": func(w *world, b *chainread.Build) func(*lifecycle.Config) {
			return func(cfg *lifecycle.Config) { cfg.Verifier = newWorld(t).pki.Verifier() }
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			w, b, _ := built(t)
			opt := mutate(w, &b)
			w.postBuild(b)
			var opts []func(*lifecycle.Config)
			if opt != nil {
				opts = append(opts, opt)
			}
			m, _, h := w.machine(opts...)
			c := client{t, h}
			for i := 0; i < 3; i++ {
				m.Step(context.Background())
			}
			if m.Stage() != lifecycle.StageFailed {
				t.Fatalf("stage %s, want failed", m.Stage())
			}
			w.beacon.Set(unlockRound)
			if code, _ := c.do("POST", "/v1/release/challenge", map[string]any{}, nil); code != http.StatusConflict {
				t.Fatalf("release challenge on a failed instance: %d", code)
			}
		})
	}
}

// Storage that doesn't match its manifest is refused too.
func TestFreshInstanceRefusesTamperedStorage(t *testing.T) {
	for _, name := range []string{"manifest.json", "token.jwt"} {
		t.Run(name, func(t *testing.T) {
			w, b, _ := built(t)
			prefix := storage.Prefix(w.exam.ExamID)
			data, _ := w.store.Get(context.Background(), prefix+name)
			data = append(data, ' ')
			if err := w.store.Put(context.Background(), prefix+name, data); err != nil {
				t.Fatal(err)
			}
			w.postBuild(b)
			m, _, _ := w.machine()
			for i := 0; i < 3; i++ {
				m.Step(context.Background())
			}
			if m.Stage() != lifecycle.StageFailed {
				t.Fatalf("stage %s, want failed", m.Stage())
			}
		})
	}
}

// Missing storage is not a verdict: the instance waits and retries.
func TestFreshInstanceWaitsForStorage(t *testing.T) {
	w, b, _ := built(t)
	w.postBuild(b)
	other := storage.Dir{Root: t.TempDir()}
	m, _, _ := w.machine(func(cfg *lifecycle.Config) { cfg.Store = other })
	if err := m.Step(context.Background()); err == nil {
		t.Fatal("expected a retryable error")
	}
	if m.Stage() != lifecycle.StageOnboard {
		t.Fatalf("stage %s", m.Stage())
	}
}

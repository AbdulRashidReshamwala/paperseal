package lifecycle_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"paperseal/tee/internal/api"
	"paperseal/tee/internal/approvedlist"
	"paperseal/tee/internal/attestation"
	"paperseal/tee/internal/attestation/attestationtest"
	"paperseal/tee/internal/chainread"
	"paperseal/tee/internal/criteria"
	"paperseal/tee/internal/encryption"
	"paperseal/tee/internal/hashing"
	"paperseal/tee/internal/lifecycle"
	"paperseal/tee/internal/release"
	"paperseal/tee/internal/settings"
	"paperseal/tee/internal/spec"
	"paperseal/tee/internal/storage"
	"paperseal/tee/internal/timelock"
	"paperseal/tee/internal/timelock/timelocktest"
	"paperseal/tee/internal/webauthn/webauthntest"
)

const (
	lockRound   = 100
	unlockRound = 35731612
	endRound    = 35732300
)

// fakeChain is a stand-in for ExamRegistry reads. The board's posts are
// methods the test calls.
type fakeChain struct {
	mu          sync.Mutex
	imageDigest [32]byte
	criteria    []byte
	created     bool
	list        *chainread.List
	build       *chainread.Build
}

func (c *fakeChain) Exam(context.Context) (chainread.ExamRecord, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.created {
		return chainread.ExamRecord{}, chainread.ErrNotPosted
	}
	return chainread.ExamRecord{ImageDigest: c.imageDigest, CreatedBlock: 1}, nil
}

func (c *fakeChain) Criteria(ctx context.Context) ([]byte, error) {
	if _, err := c.Exam(ctx); err != nil {
		return nil, err
	}
	return c.criteria, nil
}

func (c *fakeChain) ApprovedList(context.Context) (chainread.List, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.list == nil {
		return chainread.List{}, chainread.ErrNotPosted
	}
	return *c.list, nil
}

func (c *fakeChain) Build(context.Context) (chainread.Build, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.build == nil {
		return chainread.Build{}, chainread.ErrNotPosted
	}
	return *c.build, nil
}

var sampleCriteria = criteria.Criteria{
	MaxSetterPercent: 50, MinBankMultiple: 2,
	Topics: []criteria.Topic{{Name: "algebra", Questions: 3}, {Name: "geometry", Questions: 2}},
}

func examSettings(t *testing.T, criteriaHash [32]byte) settings.Exam {
	t.Helper()
	e, err := settings.Parse([]string{
		"--exam-id=0x" + strings.Repeat("11", 32), "--exam-start=1800000000", "--delta=1800",
		fmt.Sprintf("--lock-round=%d", lockRound), fmt.Sprintf("--unlock-round=%d", unlockRound),
		fmt.Sprintf("--end-round=%d", endRound),
		"--criteria-hash=0x" + fmt.Sprintf("%x", criteriaHash), "--rpc-host=rpc.example.com",
		"--registry=0x" + strings.Repeat("33", 20), "--chain-id=11155111",
	})
	if err != nil {
		t.Fatal(err)
	}
	return e
}

// person is a registered setter, key holder or centre, with a software passkey
// and the derived key a hardware key would give.
type person struct {
	owner   string
	role    approvedlist.Role
	passkey *webauthntest.Passkey
	derived *encryption.PrivateKey
}

func newPerson(t *testing.T, owner string, role approvedlist.Role) *person {
	t.Helper()
	if role == approvedlist.RoleSetter {
		// A setter's owner is the commitment, not the name.
		var examID, salt [32]byte
		m, err := hashing.SetterCommitment(examID, owner, salt)
		if err != nil {
			t.Fatal(err)
		}
		sum := m.Sum()
		owner = "0x" + hex.EncodeToString(sum[:])
	}
	p := &person{owner: owner, role: role, passkey: webauthntest.New(t)}
	if role != approvedlist.RoleSetter {
		ikm := make([]byte, 32)
		rand.Read(ikm)
		var err error
		if p.derived, err = encryption.DeriveKey(ikm); err != nil {
			t.Fatal(err)
		}
	}
	return p
}

func (p *person) derivedKey() []byte {
	if p.derived == nil {
		return nil
	}
	return p.derived.PublicKey()
}

func (p *person) entry() approvedlist.Entry {
	return approvedlist.Entry{Role: p.role, PasskeyPublicKey: p.passkey.PublicKey(), DerivedPublicKey: p.derivedKey(), Owner: p.owner}
}

// world is one exam: the people, the fake chain and drand, and the storage.
type world struct {
	t       *testing.T
	exam    settings.Exam
	crit    []byte
	chain   *fakeChain
	beacon  *timelocktest.Fake
	drand   *timelocktest.Chain
	pki     *attestationtest.PKI
	store   storage.Dir
	setters []*person
	holders []*person // Neutrals, then centre holders.
	centre  *person   // A centre without a share.
	all     []*person
}

func newWorld(t *testing.T) *world {
	t.Helper()
	crit, err := criteria.Encode(sampleCriteria)
	if err != nil {
		t.Fatal(err)
	}
	cm, _ := hashing.Criteria(crit)
	w := &world{
		t: t, crit: crit, exam: examSettings(t, cm.Sum()), beacon: &timelocktest.Fake{},
		drand: timelocktest.New(t), pki: attestationtest.NewPKI(t, timeAgo(), timeAhead()),
		store: storage.Dir{Root: t.TempDir()},
	}
	w.chain = &fakeChain{criteria: crit, imageDigest: [32]byte{0xde, 0xad}}
	for i := 0; i < 4; i++ {
		w.setters = append(w.setters, newPerson(t, fmt.Sprintf("setter-%d", i), approvedlist.RoleSetter))
	}
	for i := 0; i < spec.C.Threshold.Neutrals; i++ {
		w.holders = append(w.holders, newPerson(t, fmt.Sprintf("neutral-%d", i), approvedlist.RoleNeutral))
	}
	for i := 0; i < spec.C.Threshold.Centres; i++ {
		w.holders = append(w.holders, newPerson(t, fmt.Sprintf("centre-%d", i), approvedlist.RoleCentreHolder))
	}
	w.centre = newPerson(t, "centre-plain", approvedlist.RoleCentre)
	w.all = append(append(append([]*person{}, w.setters...), w.holders...), w.centre)
	return w
}

// machine starts a TEE instance on this world.
func (w *world) machine(opts ...func(*lifecycle.Config)) (*lifecycle.Machine, *attestation.Keys, http.Handler) {
	w.t.Helper()
	keys, err := attestation.NewKeys(w.exam.ExamID)
	if err != nil {
		w.t.Fatal(err)
	}
	cfg := lifecycle.Config{
		Exam: w.exam, Keys: keys,
		Tokens:   &attestationtest.Source{PKI: w.pki, T: w.t, Exam: w.exam, ImageDigest: w.chain.imageDigest},
		Verifier: w.pki.Verifier(), Chain: w.chain, Beacon: w.beacon,
		Sealer: timelock.NewSealer(w.drand.Chain), Store: w.store,
	}
	for _, o := range opts {
		o(&cfg)
	}
	m := lifecycle.New(cfg)
	return m, keys, api.NewHandler(m)
}

// client calls the HTTP API in-process.
type client struct {
	t *testing.T
	h http.Handler
}

func (c client) do(method, path string, body, out any) (int, string) {
	c.t.Helper()
	var rd *bytes.Reader
	if body == nil {
		rd = bytes.NewReader(nil)
	} else {
		b, err := json.Marshal(body)
		if err != nil {
			c.t.Fatal(err)
		}
		rd = bytes.NewReader(b)
	}
	rec := httptest.NewRecorder()
	c.h.ServeHTTP(rec, httptest.NewRequest(method, path, rd))
	if rec.Code == http.StatusOK && out != nil {
		if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
			c.t.Fatalf("%s %s: %v: %s", method, path, err, rec.Body)
		}
	}
	var e struct {
		Error struct{ Code string } `json:"error"`
	}
	json.Unmarshal(rec.Body.Bytes(), &e)
	return rec.Code, e.Error.Code
}

// mustOK fails the test unless the call returns 200.
func (c client) mustOK(method, path string, body, out any) {
	c.t.Helper()
	if code, why := c.do(method, path, body, out); code != http.StatusOK {
		c.t.Fatalf("%s %s: %d %s", method, path, code, why)
	}
}

func (c client) status() api.StatusResponse {
	c.t.Helper()
	var s api.StatusResponse
	c.mustOK("GET", "/v1/status", nil, &s)
	return s
}

func (c client) register(p *person, mutate func(*api.RegisterRequest)) (int, string) {
	c.t.Helper()
	var ch api.ChallengeResponse
	c.mustOK("POST", "/v1/register/challenge", map[string]any{}, &ch)
	msg, err := hashing.Registration(p.derivedKey(), []byte(p.owner), ch.Challenge)
	if err != nil {
		c.t.Fatal(err)
	}
	a := p.passkey.Sign(c.t, msg)
	req := api.RegisterRequest{
		Owner: p.owner, Challenge: ch.Challenge, PasskeyPublicKey: p.passkey.PublicKey(), DerivedPublicKey: p.derivedKey(),
		AttestationObject: []byte{0xa0}, ClientDataJSON: a.ClientDataJSON, Signature: a.Signature, AuthenticatorData: a.AuthenticatorData,
	}
	if mutate != nil {
		mutate(&req)
	}
	code, why := c.do("POST", "/v1/register", req, nil)
	return code, string(why)
}

func (c client) attestation() api.AttestationResponse {
	c.t.Helper()
	var a api.AttestationResponse
	c.mustOK("GET", "/v1/attestation", nil, &a)
	return a
}

func (w *world) postList(entries ...approvedlist.Entry) {
	w.t.Helper()
	raw, err := approvedlist.Encode(entries)
	if err != nil {
		w.t.Fatal(err)
	}
	m, _ := hashing.ApprovedList(w.exam.ExamID, raw)
	w.chain.mu.Lock()
	w.chain.list = &chainread.List{Entries: raw, Hash: m.Sum(), Block: 2}
	w.chain.mu.Unlock()
}

func (w *world) entries() []approvedlist.Entry {
	var out []approvedlist.Entry
	for _, p := range w.all {
		out = append(out, p.entry())
	}
	return out
}

func (w *world) registerAll(c client) {
	w.t.Helper()
	for _, p := range w.all {
		if code, why := c.register(p, nil); code != http.StatusOK {
			w.t.Fatalf("register %s: %d %s", p.owner, code, why)
		}
	}
}

// questionText makes a question for a setter and topic.
func questionText(setter int, topic string, i int) []byte {
	b, _ := json.Marshal(map[string]string{"topic": topic, "text": fmt.Sprintf("%s question %d from setter %d", topic, i, setter)})
	return b
}

// submit plays the setter app: pad, encrypt to the attested key, challenge,
// sign and post.
func (c client) submit(p *person, plaintext []byte, enc []byte, exam [32]byte) (int, string, api.QuestionResponse) {
	c.t.Helper()
	padded, err := encryption.Pad(plaintext, spec.C.Padding.QuestionBytes)
	if err != nil {
		c.t.Fatal(err)
	}
	ct, err := encryption.Seal(encryption.PurposeQuestion, enc, exam, padded)
	if err != nil {
		c.t.Fatal(err)
	}
	var ch api.ChallengeResponse
	c.mustOK("POST", "/v1/questions/challenge", map[string]any{}, &ch)
	hash := sha256.Sum256(ct)
	msg, _ := hashing.QuestionSubmission(exam, ch.Challenge, hash)
	a := p.passkey.Sign(c.t, msg)
	var resp api.QuestionResponse
	code, why := c.do("POST", "/v1/questions", api.QuestionRequest{
		PasskeyPublicKey: p.passkey.PublicKey(), Ciphertext: ct, Challenge: ch.Challenge,
		Signature: a.Signature, AuthenticatorData: a.AuthenticatorData, ClientDataJSON: a.ClientDataJSON,
	}, &resp)
	return code, string(why), resp
}

// releaseShare plays a key holder's app: read the share from storage, open it
// with the derived key, then sign a release and seal it to the TEE.
func (c client) releaseShare(w *world, p *person, enc []byte) (int, string) {
	c.t.Helper()
	prefix := storage.Prefix(w.exam.ExamID)
	file, err := w.store.Get(context.Background(), prefix+"shares/"+storage.Hex(p.derivedKey())+".bin")
	if err != nil {
		c.t.Fatal(err)
	}
	share, err := p.derived.Open(encryption.PurposeShare, w.exam.ExamID, file)
	if err != nil {
		c.t.Fatalf("%s cannot open their share: %v", p.owner, err)
	}
	var ch api.ChallengeResponse
	c.mustOK("POST", "/v1/release/challenge", map[string]any{}, &ch)
	msg, _ := hashing.ShareRelease(w.exam.ExamID, ch.Challenge)
	plain, err := release.EncodeRelease(share, p.passkey.Sign(c.t, msg))
	if err != nil {
		c.t.Fatal(err)
	}
	sealed, err := encryption.Seal(encryption.PurposeRelease, enc, w.exam.ExamID, plain)
	if err != nil {
		c.t.Fatal(err)
	}
	code, why := c.do("POST", "/v1/release/share", api.ShareRequest{PasskeyPublicKey: p.passkey.PublicKey(), Challenge: ch.Challenge, Sealed: sealed}, nil)
	return code, string(why)
}

// stepUntil steps the machine until it reaches a stage.
func stepUntil(t *testing.T, m *lifecycle.Machine, want lifecycle.Stage) {
	t.Helper()
	for i := 0; i < 20; i++ {
		if m.Stage() == want {
			return
		}
		if err := m.Step(context.Background()); err != nil {
			t.Fatalf("step in %s: %v", m.Stage(), err)
		}
	}
	t.Fatalf("stage is %s, want %s (failure: %v)", m.Stage(), want, m.Failure())
}

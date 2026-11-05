package chainread

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"paperseal/tee/internal/hashing"
	"paperseal/tee/internal/settings"
)

func testExam(t *testing.T) settings.Exam {
	t.Helper()
	e, err := settings.Parse([]string{
		"--exam-id=0x" + strings.Repeat("11", 32), "--exam-start=1800000000", "--delta=1800",
		"--lock-round=100", "--unlock-round=35731612", "--end-round=35732300",
		"--criteria-hash=0x" + strings.Repeat("22", 32), "--rpc-host=rpc.example.com",
		"--registry=0x" + strings.Repeat("33", 20), "--chain-id=11155111",
	})
	if err != nil {
		t.Fatal(err)
	}
	return e
}

// chain is a fake JSON-RPC node holding one registry.
type chain struct {
	t       *testing.T
	exam    settings.Exam
	chainID string

	mu          sync.Mutex
	createdAt   uint64
	listPosted  bool
	buildPosted bool
	criteria    []byte
	entries     []byte
	listHash    [32]byte
	logBlock    uint64 // the block the log is served in
	extraLogs   int
	calls       []string
	tags        []any
	logQueries  []map[string]any
	exampleSig  []byte
}

const createdBlock, postedBlock = 1000, 2000

func newChain(t *testing.T, exam settings.Exam) *chain {
	c := &chain{t: t, exam: exam, chainID: "0xaa36a7", createdAt: 5, criteria: []byte("criteria-bytes"), entries: []byte("entries-bytes"), logBlock: postedBlock}
	c.exampleSig = make([]byte, 64)
	return c
}

func (c *chain) handler(w http.ResponseWriter, r *http.Request) {
	var req rpcRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		c.t.Error(err)
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls = append(c.calls, req.Method)
	reply := func(result any) {
		json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
	}
	switch req.Method {
	case "eth_chainId":
		reply(c.chainID)
	case "eth_call":
		call := req.Params[0].(map[string]any)
		c.tags = append(c.tags, req.Params[1])
		if call["to"] != "0x"+strings.Repeat("33", 20) {
			c.t.Errorf("eth_call to %v", call["to"])
		}
		data, _ := hex.DecodeString(strings.TrimPrefix(call["data"].(string), "0x"))
		m, err := registryABI.MethodById(data[:4])
		if err != nil {
			c.t.Fatal(err)
		}
		var out []byte
		switch m.Name {
		case "getExam":
			var e examTuple
			if c.createdAt != 0 {
				e.CreatedAt, e.CreatedBlock = c.createdAt, createdBlock
			}
			e.CommitHash[0], e.ImageDigest[0] = 0xc0, 0xd1
			e.Settings.ExamId, e.Settings.ExamStart, e.Settings.Delta = c.exam.ExamID, c.exam.ExamStart, c.exam.Delta
			e.Settings.LockRound, e.Settings.UnlockRound, e.Settings.EndRound = c.exam.LockRound, c.exam.UnlockRound, c.exam.EndRound
			e.Settings.CriteriaHash, e.Settings.RpcHost = c.exam.CriteriaHash, c.exam.RPCHost
			out, err = m.Outputs.Pack(e)
		case "getApprovedList":
			var l listTuple
			if c.listPosted {
				l = listTuple{c.listHash, 7, postedBlock}
			}
			out, err = m.Outputs.Pack(l)
		case "getBuild":
			var b buildTuple
			b.TeeSignature, b.InstancePublicKey = c.exampleSig, []byte{4}
			if c.buildPosted {
				b.PostedAt, b.Selected, b.BankSize = 9, 3, 30
				b.PaperHash[0] = 1
			}
			out, err = m.Outputs.Pack(b)
		}
		if err != nil {
			c.t.Fatal(err)
		}
		reply("0x" + hex.EncodeToString(out))
	case "eth_getLogs":
		q := req.Params[0].(map[string]any)
		c.logQueries = append(c.logQueries, q)
		topics := q["topics"].([]any)
		var ev string
		for name, e := range registryABI.Events {
			if e.ID.Hex() == topics[0] {
				ev = name
			}
		}
		var data []byte
		var err error
		switch ev {
		case "ExamCreated":
			data, err = registryABI.Events[ev].Inputs.NonIndexed().Pack(
				[20]byte{}, [32]byte{}, uint64(0), uint64(0), uint64(0), uint64(0), uint64(0), [32]byte{}, "h", c.criteria)
		case "ApprovedListPosted":
			data, err = registryABI.Events[ev].Inputs.NonIndexed().Pack(c.listHash, c.entries)
		}
		if err != nil {
			c.t.Fatal(err)
		}
		block := createdBlock
		if ev == "ApprovedListPosted" {
			block = int(c.logBlock)
		}
		log := map[string]any{
			"address": "0x" + strings.Repeat("33", 20), "topics": []string{ev2topic(ev), "0x" + strings.Repeat("11", 32)},
			"data": "0x" + hex.EncodeToString(data), "blockNumber": "0x" + strings.TrimLeft(common.Bytes2Hex([]byte{byte(block >> 8), byte(block)}), "0"), "removed": false,
		}
		logs := []any{log}
		for i := 0; i < c.extraLogs; i++ {
			logs = append(logs, log)
		}
		reply(logs)
	default:
		c.t.Errorf("unexpected method %s", req.Method)
	}
}

func ev2topic(name string) string { return registryABI.Events[name].ID.Hex() }

func setup(t *testing.T) (*chain, *RPC, *httptest.Server) {
	t.Helper()
	exam := testExam(t)
	c := newChain(t, exam)
	srv := httptest.NewTLSServer(http.HandlerFunc(c.handler))
	t.Cleanup(srv.Close)
	// Trust only the test server's certificate, through the same file loader
	// the image uses.
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	path := filepath.Join(t.TempDir(), "roots.pem")
	if err := os.WriteFile(path, pemBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	roots, err := LoadRoots(path)
	if err != nil {
		t.Fatal(err)
	}
	return c, NewAt(exam, srv.URL, HTTPClient(roots)), srv
}

func listHashFor(t *testing.T, exam settings.Exam, entries []byte) [32]byte {
	t.Helper()
	// Entries here are opaque bytes, which hashing.ApprovedList accepts.
	m, err := hashing.ApprovedList(exam.ExamID, entries)
	if err != nil {
		t.Fatal(err)
	}
	return m.Sum()
}

func TestCriteriaReadsTheCreatedBlockOnly(t *testing.T) {
	c, r, _ := setup(t)
	got, err := r.Criteria(context.Background())
	if err != nil || string(got) != "criteria-bytes" {
		t.Fatalf("criteria: %q %v", got, err)
	}
	for _, tag := range c.tags {
		if tag != "finalized" {
			t.Errorf("eth_call block tag %v", tag)
		}
	}
	if len(c.logQueries) != 1 {
		t.Fatalf("%d log queries", len(c.logQueries))
	}
	q := c.logQueries[0]
	if q["fromBlock"] != "0x3e8" || q["toBlock"] != "0x3e8" {
		t.Errorf("log range %v..%v, want the single block 0x3e8", q["fromBlock"], q["toBlock"])
	}
}

func TestApprovedList(t *testing.T) {
	c, r, _ := setup(t)
	ctx := context.Background()
	if _, err := r.ApprovedList(ctx); !errors.Is(err, ErrNotPosted) {
		t.Fatalf("unposted list: want ErrNotPosted, got %v", err)
	}
	c.listPosted = true
	c.listHash = listHashFor(t, c.exam, c.entries)
	l, err := r.ApprovedList(ctx)
	if err != nil || string(l.Entries) != "entries-bytes" || l.Hash != c.listHash || l.Block != postedBlock {
		t.Fatalf("list: %+v %v", l, err)
	}
	if q := c.logQueries[len(c.logQueries)-1]; q["fromBlock"] != "0x7d0" || q["toBlock"] != "0x7d0" {
		t.Errorf("log range %v..%v", q["fromBlock"], q["toBlock"])
	}

	// Entries that don't match the on-chain hash are refused.
	c.entries = []byte("other-entries")
	if _, err := r.ApprovedList(ctx); err == nil || errors.Is(err, ErrNotPosted) {
		t.Fatalf("mismatched entries accepted: %v", err)
	}
	// So are two logs, or none.
	c.entries = []byte("entries-bytes")
	c.extraLogs = 1
	if _, err := r.ApprovedList(ctx); err == nil {
		t.Fatal("two logs accepted")
	}
}

func TestBuild(t *testing.T) {
	c, r, _ := setup(t)
	if _, err := r.Build(context.Background()); !errors.Is(err, ErrNotPosted) {
		t.Fatalf("want ErrNotPosted, got %v", err)
	}
	c.buildPosted = true
	b, err := r.Build(context.Background())
	if err != nil || b.Selected != 3 || b.BankSize != 30 || b.PaperHash[0] != 1 || len(b.TEESignature) != 64 {
		t.Fatalf("build: %+v %v", b, err)
	}
}

func TestExamMustMatchSettings(t *testing.T) {
	c, r, _ := setup(t)
	c.exam.Delta++
	if _, err := r.Exam(context.Background()); !errors.Is(err, ErrWrongExam) {
		t.Fatalf("want ErrWrongExam, got %v", err)
	}
	c.exam.Delta--
	c.createdAt = 0
	if _, err := r.Exam(context.Background()); !errors.Is(err, ErrNotPosted) {
		t.Fatalf("uncreated exam: %v", err)
	}
}

func TestWrongChain(t *testing.T) {
	c, r, _ := setup(t)
	c.chainID = "0x1"
	if _, err := r.Criteria(context.Background()); err == nil || !strings.Contains(err.Error(), "chain") {
		t.Fatalf("wrong chain accepted: %v", err)
	}
}

func TestOnlyTheImageRootsAreTrusted(t *testing.T) {
	_, _, srv := setup(t)
	exam := testExam(t)
	// A pool without the server's certificate refuses the connection.
	// httptest servers all share one certificate, so make an unrelated one.
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, err := x509.CreateCertificate(rand.Reader, &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "unrelated"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true,
	}, &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "unrelated"}}, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	unrelated, _ := x509.ParseCertificate(der)
	pool := x509.NewCertPool()
	pool.AddCert(unrelated)
	r := NewAt(exam, srv.URL, HTTPClient(pool))
	if _, err := r.Criteria(context.Background()); err == nil {
		t.Fatal("connected to a server whose certificate is not in the roots")
	}
	// The roots file must hold certificates.
	bad := filepath.Join(t.TempDir(), "bad.pem")
	os.WriteFile(bad, []byte("nothing"), 0o600)
	if _, err := LoadRoots(bad); err == nil {
		t.Fatal("accepted a roots file with no certificates")
	}
	if _, err := LoadRoots(filepath.Join(t.TempDir(), "missing.pem")); err == nil {
		t.Fatal("accepted a missing roots file")
	}
}

func TestRedirectsAndRPCErrors(t *testing.T) {
	exam := testExam(t)
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://elsewhere.invalid/", http.StatusFound)
	}))
	defer redirect.Close()
	if _, err := NewAt(exam, redirect.URL, HTTPClient(x509.NewCertPool())).Criteria(context.Background()); err == nil {
		t.Fatal("followed a redirect")
	}
	rpcErr := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"range too large"}}`))
	}))
	defer rpcErr.Close()
	if _, err := NewAt(exam, rpcErr.URL, HTTPClient(x509.NewCertPool())).Criteria(context.Background()); err == nil ||
		!strings.Contains(err.Error(), "range too large") {
		t.Fatalf("rpc error: %v", err)
	}
}

// The embedded ABI must match the contract that Foundry built, when it is there.
func TestABIMatchesFoundryOutput(t *testing.T) {
	b, err := os.ReadFile("../../../contracts/out/ExamRegistry.sol/ExamRegistry.json")
	if err != nil {
		t.Skip("contracts/out is not built")
	}
	var art struct {
		MethodIdentifiers map[string]string `json:"methodIdentifiers"`
	}
	if err := json.Unmarshal(b, &art); err != nil {
		t.Fatal(err)
	}
	for name, m := range registryABI.Methods {
		want := ""
		for sig, id := range art.MethodIdentifiers {
			if strings.HasPrefix(sig, name+"(") {
				want = id
			}
		}
		if want != hex.EncodeToString(m.ID) {
			t.Errorf("%s: selector %x, Foundry says %q", name, m.ID, want)
		}
	}
}

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
	"paperseal/tee/internal/spec"
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
	code        string // the eth_getCode result, the sample code by default
	codeErr     bool   // eth_getCode answers with an RPC error
	extraLogs   int
	removedLogs int // 1: the node serves only a removed log. 2: a removed log, then the real one.
	calls       []string
	tags        []any
	logQueries  []map[string]any
	exampleSig  []byte
}

const createdBlock, postedBlock = 1000, 2000

func newChain(t *testing.T, exam settings.Exam) *chain {
	c := &chain{t: t, exam: exam, chainID: "0xaa36a7", code: sampleCode(t).Code, createdAt: 5, criteria: []byte("criteria-bytes"), entries: []byte("entries-bytes"), logBlock: postedBlock}
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
	case "eth_getCode":
		if req.Params[0] != "0x"+strings.Repeat("33", 20) {
			c.t.Errorf("eth_getCode at %v", req.Params[0])
		}
		c.tags = append(c.tags, req.Params[1])
		if c.codeErr {
			json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32000, "message": "busy"}})
			return
		}
		reply(c.code)
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
				b.PostedAt, b.Selected, b.BankSize, b.BuiltRound = 9, 3, 30, 777
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
		if c.removedLogs > 0 {
			gone := map[string]any{}
			for k, v := range log {
				gone[k] = v
			}
			gone["removed"] = true
			if c.removedLogs == 1 {
				logs = []any{gone}
			} else {
				logs = []any{gone, log}
			}
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
		if tag != spec.C.Chain.ReadBlock {
			t.Errorf("eth_call block tag %v, want the constant %s", tag, spec.C.Chain.ReadBlock)
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

// Both values of chain.readBlock go out as the eth_call tag on every read, and
// neither changes the log query, which stays on one numbered block.
func TestReadBlockIsTheCallTag(t *testing.T) {
	for _, tag := range []string{spec.ReadBlockLatest, spec.ReadBlockFinalized} {
		t.Run(tag, func(t *testing.T) {
			c, r, _ := setup(t)
			r.readBlock = tag
			c.listPosted, c.buildPosted = true, true
			c.listHash = listHashFor(t, c.exam, c.entries)
			ctx := context.Background()
			if _, err := r.Exam(ctx); err != nil {
				t.Fatalf("exam: %v", err)
			}
			if _, err := r.Criteria(ctx); err != nil {
				t.Fatalf("criteria: %v", err)
			}
			if _, err := r.ApprovedList(ctx); err != nil {
				t.Fatalf("list: %v", err)
			}
			if _, err := r.Build(ctx); err != nil {
				t.Fatalf("build: %v", err)
			}
			if len(c.tags) != 5 {
				t.Fatalf("%d tagged reads, want one eth_getCode and four eth_calls", len(c.tags))
			}
			for _, got := range c.tags {
				if got != tag {
					t.Errorf("block tag %v, want %s", got, tag)
				}
			}
			want := []string{"0x3e8", "0x7d0"}
			if len(c.logQueries) != len(want) {
				t.Fatalf("%d log queries, want %d", len(c.logQueries), len(want))
			}
			for i, q := range c.logQueries {
				if q["fromBlock"] != want[i] || q["toBlock"] != want[i] {
					t.Errorf("log range %v..%v, want the single block %s", q["fromBlock"], q["toBlock"], want[i])
				}
			}
		})
	}
}

// At latest, a getter can name a block whose log the RPC node can't serve yet.
// That must be a retryable error, not ErrNotPosted or a wrong answer.
func TestRecordWithoutItsLogIsRetryable(t *testing.T) {
	c, r, _ := setup(t)
	r.readBlock = spec.ReadBlockLatest
	c.listPosted = true
	c.listHash = listHashFor(t, c.exam, c.entries)
	c.logBlock = postedBlock + 1 // The node's log is not in the block the record names.
	ctx := context.Background()
	if _, err := r.ApprovedList(ctx); err == nil || errors.Is(err, ErrNotPosted) || errors.Is(err, ErrWrongExam) ||
		!strings.Contains(err.Error(), "want one log") {
		t.Fatalf("got %v", err)
	}
	c.logBlock = postedBlock
	if _, err := r.ApprovedList(ctx); err != nil {
		t.Fatalf("retry: %v", err)
	}
}

// A reorg marks a log `removed`. It isn't on the chain any more, so it can't count
// as the record's log, and the read is retried.
func TestRemovedLogsDoNotCount(t *testing.T) {
	c, r, _ := setup(t)
	c.listPosted = true
	c.entries = []byte("the-list")
	c.listHash = listHashFor(t, c.exam, c.entries)
	c.removedLogs = 1
	ctx := context.Background()
	if _, err := r.ApprovedList(ctx); err == nil || errors.Is(err, ErrNotPosted) || !strings.Contains(err.Error(), "found 0") {
		t.Fatalf("only a removed log: got %v", err)
	}
	c.removedLogs = 2
	list, err := r.ApprovedList(ctx)
	if err != nil {
		t.Fatalf("removed log beside the real one: %v", err)
	}
	if string(list.Entries) != "the-list" {
		t.Fatalf("entries %q", list.Entries)
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
	if err != nil || b.Selected != 3 || b.BankSize != 30 || b.BuiltRound != 777 || b.PaperHash[0] != 1 || len(b.TEESignature) != 64 {
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

func TestEventDataSizeIsCappedBeforeDecoding(t *testing.T) {
	lim := spec.C.Limits
	c, r, _ := setup(t)
	ctx := context.Background()

	c.criteria = make([]byte, lim.CriteriaBytes)
	if _, err := r.Criteria(ctx); err != nil {
		t.Fatalf("criteria at the cap: %v", err)
	}
	c.criteria = make([]byte, lim.CriteriaBytes+eventOverhead+64)
	if _, err := r.Criteria(ctx); err == nil || !strings.Contains(err.Error(), "log data is") {
		t.Fatalf("oversized criteria event: %v", err)
	}

	c.listPosted = true
	c.entries = make([]byte, lim.EntriesBytes)
	c.listHash = listHashFor(t, c.exam, c.entries)
	if _, err := r.ApprovedList(ctx); err != nil {
		t.Fatalf("entries at the cap: %v", err)
	}
	c.entries = make([]byte, lim.EntriesBytes+eventOverhead+64)
	c.listHash = listHashFor(t, c.exam, c.entries)
	if _, err := r.ApprovedList(ctx); err == nil || !strings.Contains(err.Error(), "log data is") {
		t.Fatalf("oversized entries event: %v", err)
	}
}

func TestResponseIsCappedAtOneMiB(t *testing.T) {
	if maxResponse != 1<<20 {
		t.Fatalf("maxResponse %d", maxResponse)
	}
	big := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":"`))
		w.Write(make([]byte, maxResponse))
		w.Write([]byte(`"}`))
	}))
	defer big.Close()
	_, err := NewAt(testExam(t), big.URL, big.Client()).Criteria(context.Background())
	if err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("got %v", err)
	}
}

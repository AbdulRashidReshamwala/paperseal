// Package chainread is all the TEE reads from the chain: the exam record, the
// selection criteria, the approved list and the Build. The TEE has no wallet and
// sends no transactions.
//
// Each read has two steps over TLS to exam.RPCHost, for exam.Registry and
// exam.ExamID. First eth_call a getter at the finalized block, which gives the
// record and the one block that holds its log. A record with no block isn't
// written yet, and that is ErrNotPosted. Then call eth_getLogs with fromBlock and
// toBlock both set to that block. Never search a range, because public RPC
// operators reject wide ones.
//
// Root certificates must come from the image, because the image is attested.
// The TLS config loads them from a fixed path in the image into its own
// RootCAs, so neither the host's roots nor SSL_CERT_FILE and SSL_CERT_DIR can
// add one. That is what stops the board's network changing these reads. It can
// still block them.
package chainread

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"

	"paperseal/tee/internal/hashing"
	"paperseal/tee/internal/settings"
)

// RootsPath is where the image holds the TLS root certificates the TEE trusts.
// The Dockerfile copies them there from the pinned build image.
const RootsPath = "/etc/paperseal/roots.pem"

// maxResponse bounds an RPC response. The approved list is the largest.
const maxResponse = 16 << 20

// Errors a caller can act on.
var (
	// ErrNotPosted means the record isn't written yet, so the caller waits.
	ErrNotPosted = errors.New("chainread: not posted yet")
	// ErrWrongExam means the chain holds an exam that differs from the attested
	// settings, so nothing from it can be trusted.
	ErrWrongExam = errors.New("chainread: on-chain exam differs from the attested settings")
)

// Source is what the lifecycle reads. RPC is the real one.
type Source interface {
	// Exam returns the exam record, after checking it matches the settings.
	Exam(ctx context.Context) (ExamRecord, error)
	// Criteria returns the `criteria` bytes emitted in ExamCreated. The caller
	// must compare their hashing.Criteria hash with the attested criteriaHash,
	// then check them with criteria.Decode.
	Criteria(ctx context.Context) ([]byte, error)
	// ApprovedList returns the `entries` bytes emitted in ApprovedListPosted,
	// already checked against the on-chain list hash, for approvedlist.Decode.
	ApprovedList(ctx context.Context) (List, error)
	// Build returns the posted Build, or ErrNotPosted.
	Build(ctx context.Context) (Build, error)
}

// ExamRecord is the part of getExam the TEE uses.
type ExamRecord struct {
	CommitHash   [20]byte
	ImageDigest  [32]byte
	CreatedBlock uint64
}

// List is the posted approved list.
type List struct {
	Entries []byte
	Hash    [32]byte // The approvedList message hash, from the contract.
	Block   uint64
}

// Build is the posted Build.
type Build struct {
	ApprovedListHash    [32]byte
	PaperHash           [32]byte
	StorageManifestHash [32]byte
	SaltedPaperHash     [32]byte
	Selected            uint32
	BankSize            uint32
	CriteriaHash        [32]byte
	TEESignature        []byte
	InstancePublicKey   []byte
}

// LoadRoots reads root certificates from a PEM file into a fresh pool. It never
// starts from the host's roots.
func LoadRoots(path string) (*x509.CertPool, error) {
	pem, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("chainread: root certificates: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("chainread: no certificates in %s", path)
	}
	return pool, nil
}

// HTTPClient returns a client that trusts only the given roots and ignores
// proxy settings in the environment.
func HTTPClient(roots *x509.CertPool) *http.Client {
	return &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			Proxy:           nil,
			TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12},
			// A redirect could lead to another host, so the client refuses them.
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// RPC reads ExamRegistry through JSON-RPC.
type RPC struct {
	exam   settings.Exam
	url    string
	client *http.Client

	mu      sync.Mutex
	chainOK bool
	nextID  int
}

var _ Source = (*RPC)(nil)

// New reads from https://<rpcHost>/ with a client that trusts only roots.
func New(exam settings.Exam, roots *x509.CertPool) *RPC {
	return &RPC{exam: exam, url: "https://" + exam.RPCHost + "/", client: HTTPClient(roots)}
}

// NewAt reads from an explicit URL with an explicit client. It is for tests
// against httptest, which can't serve the attested host name.
func NewAt(exam settings.Exam, url string, client *http.Client) *RPC {
	return &RPC{exam: exam, url: url, client: client}
}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

type rpcResponse struct {
	ID     int             `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (r *RPC) call(ctx context.Context, method string, params ...any) (json.RawMessage, error) {
	r.mu.Lock()
	r.nextID++
	id := r.nextID
	r.mu.Unlock()
	body, err := json.Marshal(rpcRequest{"2.0", id, method, params})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := r.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("chainread: %s: %w", method, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse+1))
	if err != nil {
		return nil, fmt.Errorf("chainread: %s: %w", method, err)
	}
	if len(raw) > maxResponse {
		return nil, fmt.Errorf("chainread: %s: response too large", method)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("chainread: %s: status %d", method, resp.StatusCode)
	}
	var out rpcResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("chainread: %s: response: %w", method, err)
	}
	if out.Error != nil {
		return nil, fmt.Errorf("chainread: %s: rpc error %d: %s", method, out.Error.Code, out.Error.Message)
	}
	if out.ID != id {
		return nil, fmt.Errorf("chainread: %s: response id %d, want %d", method, out.ID, id)
	}
	return out.Result, nil
}

// checkChain confirms the RPC operator serves the attested chain, once.
func (r *RPC) checkChain(ctx context.Context) error {
	r.mu.Lock()
	ok := r.chainOK
	r.mu.Unlock()
	if ok {
		return nil
	}
	raw, err := r.call(ctx, "eth_chainId")
	if err != nil {
		return err
	}
	id, err := parseQuantity(raw)
	if err != nil {
		return fmt.Errorf("chainread: eth_chainId: %w", err)
	}
	if id != r.exam.ChainID {
		return fmt.Errorf("chainread: RPC serves chain %d, settings name %d", id, r.exam.ChainID)
	}
	r.mu.Lock()
	r.chainOK = true
	r.mu.Unlock()
	return nil
}

func (r *RPC) registryHex() string { return "0x" + hex.EncodeToString(r.exam.Registry[:]) }

// ethCall calls a getter at the finalized block and unpacks its one output.
func (r *RPC) ethCall(ctx context.Context, method string) ([]any, error) {
	if err := r.checkChain(ctx); err != nil {
		return nil, err
	}
	data, err := registryABI.Pack(method, r.exam.ExamID)
	if err != nil {
		return nil, err
	}
	raw, err := r.call(ctx, "eth_call",
		map[string]string{"to": r.registryHex(), "data": "0x" + hex.EncodeToString(data)}, "finalized")
	if err != nil {
		return nil, err
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("chainread: eth_call %s: result: %w", method, err)
	}
	out, err := hex.DecodeString(strings.TrimPrefix(s, "0x"))
	if err != nil {
		return nil, fmt.Errorf("chainread: eth_call %s: result is not hex", method)
	}
	vals, err := registryABI.Unpack(method, out)
	if err != nil {
		return nil, fmt.Errorf("chainread: eth_call %s: %w", method, err)
	}
	return vals, nil
}

type rpcLog struct {
	Address     string   `json:"address"`
	Topics      []string `json:"topics"`
	Data        string   `json:"data"`
	BlockNumber string   `json:"blockNumber"`
	Removed     bool     `json:"removed"`
}

// eventData reads the one log of an event for this exam in exactly one block.
func (r *RPC) eventData(ctx context.Context, event string, block uint64) (map[string]any, error) {
	ev, ok := registryABI.Events[event]
	if !ok {
		return nil, fmt.Errorf("chainread: unknown event %s", event)
	}
	q := fmt.Sprintf("0x%x", block)
	raw, err := r.call(ctx, "eth_getLogs", map[string]any{
		"address":   r.registryHex(),
		"fromBlock": q,
		"toBlock":   q,
		"topics":    []string{ev.ID.Hex(), "0x" + hex.EncodeToString(r.exam.ExamID[:])},
	})
	if err != nil {
		return nil, err
	}
	var logs []rpcLog
	if err := json.Unmarshal(raw, &logs); err != nil {
		return nil, fmt.Errorf("chainread: eth_getLogs: %w", err)
	}
	var found []rpcLog
	for _, l := range logs {
		// Check what the filter should have: an RPC operator can answer wrongly.
		if l.Removed || !strings.EqualFold(l.Address, r.registryHex()) || len(l.Topics) != 2 ||
			!strings.EqualFold(l.Topics[0], ev.ID.Hex()) ||
			!strings.EqualFold(l.Topics[1], "0x"+hex.EncodeToString(r.exam.ExamID[:])) {
			continue
		}
		if n, err := parseQuantity(json.RawMessage(`"` + l.BlockNumber + `"`)); err != nil || n != block {
			continue
		}
		found = append(found, l)
	}
	if len(found) != 1 {
		return nil, fmt.Errorf("chainread: %s: want one log in block %d, found %d", event, block, len(found))
	}
	data, err := hex.DecodeString(strings.TrimPrefix(found[0].Data, "0x"))
	if err != nil {
		return nil, fmt.Errorf("chainread: %s: log data is not hex", event)
	}
	out := map[string]any{}
	if err := ev.Inputs.NonIndexed().UnpackIntoMap(out, data); err != nil {
		return nil, fmt.Errorf("chainread: %s: %w", event, err)
	}
	return out, nil
}

// Exam implements Source.
func (r *RPC) Exam(ctx context.Context) (ExamRecord, error) {
	vals, err := r.ethCall(ctx, "getExam")
	if err != nil {
		return ExamRecord{}, err
	}
	var e examTuple
	if len(vals) != 1 {
		return ExamRecord{}, errors.New("chainread: getExam: unexpected output")
	}
	e = *abi.ConvertType(vals[0], new(examTuple)).(*examTuple)
	if e.CreatedAt == 0 || e.CreatedBlock == 0 {
		return ExamRecord{}, fmt.Errorf("%w: exam is not created", ErrNotPosted)
	}
	s, x := e.Settings, r.exam
	if s.ExamId != x.ExamID || s.ExamStart != x.ExamStart || s.Delta != x.Delta ||
		s.LockRound != x.LockRound || s.UnlockRound != x.UnlockRound || s.EndRound != x.EndRound ||
		s.CriteriaHash != x.CriteriaHash || s.RpcHost != x.RPCHost {
		return ExamRecord{}, ErrWrongExam
	}
	return ExamRecord{e.CommitHash, e.ImageDigest, e.CreatedBlock}, nil
}

// Criteria implements Source.
func (r *RPC) Criteria(ctx context.Context) ([]byte, error) {
	rec, err := r.Exam(ctx)
	if err != nil {
		return nil, err
	}
	data, err := r.eventData(ctx, "ExamCreated", rec.CreatedBlock)
	if err != nil {
		return nil, err
	}
	c, ok := data["criteria"].([]byte)
	if !ok {
		return nil, errors.New("chainread: ExamCreated has no criteria")
	}
	return c, nil
}

// ApprovedList implements Source.
func (r *RPC) ApprovedList(ctx context.Context) (List, error) {
	vals, err := r.ethCall(ctx, "getApprovedList")
	if err != nil {
		return List{}, err
	}
	if len(vals) != 1 {
		return List{}, errors.New("chainread: getApprovedList: unexpected output")
	}
	rec := *abi.ConvertType(vals[0], new(listTuple)).(*listTuple)
	if rec.PostedAt == 0 || rec.PostedBlock == 0 {
		return List{}, ErrNotPosted
	}
	data, err := r.eventData(ctx, "ApprovedListPosted", rec.PostedBlock)
	if err != nil {
		return List{}, err
	}
	entries, ok := data["entries"].([]byte)
	if !ok {
		return List{}, errors.New("chainread: ApprovedListPosted has no entries")
	}
	// The contract hashed these exact bytes, so a log that disagrees with the
	// record is not what was posted.
	m, err := hashing.ApprovedList(r.exam.ExamID, entries)
	if err != nil {
		return List{}, err
	}
	if m.Sum() != rec.ListHash {
		return List{}, errors.New("chainread: logged entries do not match the on-chain list hash")
	}
	return List{Entries: entries, Hash: rec.ListHash, Block: rec.PostedBlock}, nil
}

// Build implements Source.
func (r *RPC) Build(ctx context.Context) (Build, error) {
	vals, err := r.ethCall(ctx, "getBuild")
	if err != nil {
		return Build{}, err
	}
	if len(vals) != 1 {
		return Build{}, errors.New("chainread: getBuild: unexpected output")
	}
	b := *abi.ConvertType(vals[0], new(buildTuple)).(*buildTuple)
	if b.PostedAt == 0 {
		return Build{}, ErrNotPosted
	}
	if len(b.TeeSignature) != 64 {
		return Build{}, fmt.Errorf("chainread: build signature is %d bytes", len(b.TeeSignature))
	}
	return Build{
		ApprovedListHash: b.ApprovedListHash, PaperHash: b.PaperHash,
		StorageManifestHash: b.StorageManifestHash, SaltedPaperHash: b.SaltedPaperHash,
		Selected: b.Selected, BankSize: b.BankSize, CriteriaHash: b.CriteriaHash,
		TEESignature: b.TeeSignature, InstancePublicKey: b.InstancePublicKey,
	}, nil
}

func parseQuantity(raw json.RawMessage) (uint64, error) {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return 0, err
	}
	digits, ok := strings.CutPrefix(s, "0x")
	if !ok || digits == "" || len(digits) > 16 {
		return 0, errors.New("not a hex quantity")
	}
	var n uint64
	if _, err := fmt.Sscanf(digits, "%x", &n); err != nil {
		return 0, errors.New("not a hex quantity")
	}
	return n, nil
}

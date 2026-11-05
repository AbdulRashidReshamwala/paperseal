package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"

	"paperseal/tee/internal/approvedlist"
	"paperseal/tee/internal/attestation"
	"paperseal/tee/internal/bank"
	"paperseal/tee/internal/build"
	"paperseal/tee/internal/chainread"
	"paperseal/tee/internal/criteria"
	"paperseal/tee/internal/hashing"
	"paperseal/tee/internal/lock"
	"paperseal/tee/internal/notimpl"
	"paperseal/tee/internal/outbox"
	"paperseal/tee/internal/release"
	"paperseal/tee/internal/settings"
	"paperseal/tee/internal/storage"
	"paperseal/tee/internal/timelock"
)

func do(t *testing.T, h http.Handler, method, path, body string) (*httptest.ResponseRecorder, errorBody) {
	t.Helper()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(body)))
	var got errorBody
	dec := json.NewDecoder(w.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&got); err != nil {
		t.Fatalf("%s %s: body does not match the error shape: %v", method, path, err)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("%s %s: Content-Type %q", method, path, ct)
	}
	return w, got
}

func TestEveryRouteReturns501(t *testing.T) {
	h := NewHandler(Unimplemented{})
	for _, r := range routes(Unimplemented{}) {
		w, got := do(t, h, r.method, r.path, "{}")
		if w.Code != http.StatusNotImplemented {
			t.Errorf("%s %s: status %d", r.method, r.path, w.Code)
		}
		if got.Error.Code != "not_implemented" || got.Error.Message == "" {
			t.Errorf("%s %s: error %+v", r.method, r.path, got.Error)
		}
	}
}

// The route table must match the one in docs/ARCHITECTURE.md.
func TestRoutesMatchArchitecture(t *testing.T) {
	doc, err := os.ReadFile("../../../docs/ARCHITECTURE.md")
	if err != nil {
		t.Fatal(err)
	}
	documented := map[string]bool{}
	for _, m := range regexp.MustCompile("`(GET|POST) (/v1/[^`]*)`").FindAllStringSubmatch(string(doc), -1) {
		documented[m[1]+" "+m[2]] = true
	}
	rs := routes(Unimplemented{})
	if len(documented) != len(rs) {
		t.Errorf("documented %d routes, serving %d", len(documented), len(rs))
	}
	for _, r := range rs {
		if !documented[r.method+" "+r.path] {
			t.Errorf("%s %s is not documented", r.method, r.path)
		}
	}
}

func TestCrossOriginReadsOnly(t *testing.T) {
	h := NewHandler(Unimplemented{})
	for _, r := range routes(Unimplemented{}) {
		w, _ := do(t, h, r.method, r.path, "{}")
		got := w.Header().Get("Access-Control-Allow-Origin")
		if r.method == http.MethodGet && got != "*" {
			t.Errorf("GET %s: allow-origin %q", r.path, got)
		}
		if r.method == http.MethodPost && got != "" {
			t.Errorf("POST %s: allow-origin %q", r.path, got)
		}
	}
}

func TestNotFound(t *testing.T) {
	h := NewHandler(Unimplemented{})
	for _, path := range []string{"/", "/v1", "/v1/unknown", "/v1/status/extra"} {
		w, got := do(t, h, http.MethodGet, path, "")
		if w.Code != http.StatusNotFound || got.Error.Code != "not_found" {
			t.Errorf("%s: %d %+v", path, w.Code, got.Error)
		}
	}
}

func TestMethodNotAllowed(t *testing.T) {
	h := NewHandler(Unimplemented{})
	w, got := do(t, h, http.MethodPost, "/v1/status", "")
	if w.Code != http.StatusMethodNotAllowed || got.Error.Code != "method_not_allowed" {
		t.Fatalf("%d %+v", w.Code, got.Error)
	}
	if allow := w.Header().Get("Allow"); allow != http.MethodGet {
		t.Fatalf("Allow %q", allow)
	}
}

func TestBodyTooLarge(t *testing.T) {
	h := NewHandler(Unimplemented{})
	w, got := do(t, h, http.MethodPost, "/v1/questions", strings.Repeat("x", maxBody+1))
	if w.Code != http.StatusRequestEntityTooLarge || got.Error.Code != "body_too_large" {
		t.Fatalf("%d %+v", w.Code, got.Error)
	}
}

type failing struct {
	Unimplemented
	err error
}

func (f failing) Status(context.Context) (any, error) { return nil, f.err }

func TestInternalErrorsStayPrivate(t *testing.T) {
	h := NewHandler(failing{err: errors.New("secret detail")})
	w, got := do(t, h, http.MethodGet, "/v1/status", "")
	if w.Code != http.StatusInternalServerError || got.Error.Code != "internal" {
		t.Fatalf("%d %+v", w.Code, got.Error)
	}
	if strings.Contains(got.Error.Message, "secret") {
		t.Fatalf("leaked %q", got.Error.Message)
	}
}

// A wrapped not-implemented error is still a 501.
func TestWrappedNotImplemented(t *testing.T) {
	h := NewHandler(failing{err: errors.Join(errors.New("context"), notimpl.New("deep.Op"))})
	w, got := do(t, h, http.MethodGet, "/v1/status", "")
	if w.Code != http.StatusNotImplemented || got.Error.Message != "deep.Op: not implemented" {
		t.Fatalf("%d %+v", w.Code, got.Error)
	}
}

// No stub may pretend to work.
func TestStubsAreNotImplemented(t *testing.T) {
	ctx := context.Background()
	check := func(name string, err error) {
		t.Helper()
		if !notimpl.Is(err) {
			t.Errorf("%s: got %v", name, err)
		}
	}
	_, err := attestation.Launcher{}.Token(ctx, attestation.TokenPKI, "", "")
	check("attestation.Token", err)
	_, err = attestation.InstanceKey{}.Sign(ctx, hashing.Message{})
	check("attestation.Sign", err)
	check("bank.Add", bank.Memory{}.Add(ctx, bank.Submission{}))
	_, err = bank.Memory{}.All(ctx)
	check("bank.All", err)
	_, err = lock.Bank{}.Lock(ctx, criteria.Criteria{})
	check("lock.Lock", err)
	_, err = build.Selector{}.Build(ctx, criteria.Criteria{})
	check("build.Build", err)
	_, err = timelock.Drand{}.Seal(ctx, 1, nil)
	check("timelock.Seal", err)
	_, err = timelock.Drand{}.Randomness(ctx, 1)
	check("timelock.Randomness", err)
	_, err = release.Unlock{}.Challenge(ctx, nil)
	check("release.Challenge", err)
	check("release.Submit", release.Unlock{}.Submit(ctx, release.Share{}))
	_, err = release.Unlock{}.Progress(ctx)
	check("release.Progress", err)
	_, err = release.Unlock{}.Log(ctx)
	check("release.Log", err)
	check("outbox.Put", outbox.Memory{}.Put(ctx, outbox.Message{}))
	_, err = outbox.Memory{}.List(ctx)
	check("outbox.List", err)
	check("storage.Put", storage.Bucket{}.Put(ctx, "", nil))
	_, err = chainread.Criteria(ctx, settings.Exam{})
	check("chainread.Criteria", err)
	_, err = chainread.ApprovedList(ctx, settings.Exam{})
	check("chainread.ApprovedList", err)
	check("approvedlist.CheckRegistered", approvedlist.CheckRegistered(ctx, nil))
}

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

	"paperseal/tee/internal/notimpl"
	"paperseal/tee/internal/release"
)

// stub answers every route with fixed values, and records requests.
type stub struct {
	err       error
	register  RegisterRequest
	questions QuestionRequest
	share     ShareRequest
}

func (s *stub) Attestation(context.Context) (AttestationResponse, error) {
	return AttestationResponse{Token: "t", Attested: true, InstancePublicKey: Hex{4}}, s.err
}
func (s *stub) Status(context.Context) (StatusResponse, error) {
	return StatusResponse{Stage: "submit", Release: ReleaseStatus{Released: []Hex{}, Required: 8}}, s.err
}
func (s *stub) RegisterChallenge(context.Context) (ChallengeResponse, error) {
	return ChallengeResponse{Hex{1, 2}}, s.err
}
func (s *stub) Registrations(context.Context) (RegistrationsResponse, error) {
	return RegistrationsResponse{Registrations: []Registration{}}, s.err
}
func (s *stub) Register(_ context.Context, r RegisterRequest) error { s.register = r; return s.err }
func (s *stub) QuestionChallenge(context.Context) (ChallengeResponse, error) {
	return ChallengeResponse{Hex{3}}, s.err
}
func (s *stub) Questions(_ context.Context, r QuestionRequest) (QuestionResponse, error) {
	s.questions = r
	return QuestionResponse{Hex{5}, Hex{6}}, s.err
}
func (s *stub) Outbox(context.Context) (OutboxResponse, error) {
	return OutboxResponse{Messages: []OutboxMessage{}}, s.err
}
func (s *stub) ReleaseChallenge(context.Context) (ChallengeResponse, error) {
	return ChallengeResponse{Hex{7}}, s.err
}
func (s *stub) ReleaseShare(_ context.Context, r ShareRequest) error { s.share = r; return s.err }
func (s *stub) ReleaseLog(context.Context) (release.Log, error) {
	return release.Log{ExamID: "0x01", Entries: []release.LogEntry{}, EntriesHash: "0x02", TEESignature: "0x03"}, s.err
}

func do(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(body)))
	return w
}

func errorOf(t *testing.T, w *httptest.ResponseRecorder) errorDetail {
	t.Helper()
	var got errorBody
	dec := json.NewDecoder(w.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&got); err != nil {
		t.Fatalf("body does not match the error shape: %v", err)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type %q", ct)
	}
	return got.Error
}

// The route table must match the TEE API table in spec/api.md.
func TestRoutesMatchSpec(t *testing.T) {
	doc, err := os.ReadFile("../../../spec/api.md")
	if err != nil {
		t.Fatal(err)
	}
	section := string(doc)[strings.Index(string(doc), "## TEE API\n"):]
	section = section[:strings.Index(section[3:], "\n## ")+3]
	documented := map[string]bool{}
	for _, m := range regexp.MustCompile("`(GET|POST) (/v1/[^`]*)`").FindAllStringSubmatch(section, -1) {
		documented[m[1]+" "+m[2]] = true
	}
	rs := routes(&stub{})
	if len(documented) != len(rs) {
		t.Errorf("documented %d routes, serving %d", len(documented), len(rs))
	}
	for _, r := range rs {
		if !documented[r.method+" "+r.path] {
			t.Errorf("%s %s is not in the spec", r.method, r.path)
		}
	}
	for _, removed := range []string{"/v1/lock", "/v1/build", "/v1/onboard/list"} {
		if w := do(NewHandler(&stub{}), http.MethodPost, removed, "{}"); w.Code != http.StatusNotFound {
			t.Errorf("%s still answers: %d", removed, w.Code)
		}
	}
}

func TestEveryRouteWorks(t *testing.T) {
	s := &stub{}
	h := NewHandler(s)
	for _, r := range routes(s) {
		body := "{}"
		if r.path == "/v1/register" || r.path == "/v1/questions" || r.path == "/v1/release/share" {
			body = "{}"
		}
		w := do(h, r.method, r.path, body)
		if w.Code != http.StatusOK {
			t.Errorf("%s %s: %d %s", r.method, r.path, w.Code, w.Body)
			continue
		}
		if !json.Valid(w.Body.Bytes()) {
			t.Errorf("%s %s: not JSON", r.method, r.path)
		}
	}
	// Post routes that return nothing return {}.
	if w := do(h, http.MethodPost, "/v1/register", "{}"); strings.TrimSpace(w.Body.String()) != "{}" {
		t.Errorf("register body %q", w.Body)
	}
	if w := do(h, http.MethodPost, "/v1/register/challenge", ""); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"challenge":"0x0102"`) {
		t.Errorf("an empty body must do for {}: %d %s", w.Code, w.Body)
	}
}

func TestRequestBodies(t *testing.T) {
	s := &stub{}
	h := NewHandler(s)
	w := do(h, http.MethodPost, "/v1/register", `{"owner":"o","challenge":"0x01","passkeyPublicKey":"0x04",
		"derivedPublicKey":"0x","attestationObject":"0xaa","clientDataJSON":"0xbb","signature":"0xcc","authenticatorData":"0xdd"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if s.register.Owner != "o" || len(s.register.DerivedPublicKey) != 0 || s.register.Signature[0] != 0xcc {
		t.Fatalf("decoded %+v", s.register)
	}
	bad := map[string]string{
		"unknown field":  `{"owner":"o","extra":1}`,
		"uppercase hex":  `{"challenge":"0xAB"}`,
		"no prefix":      `{"challenge":"ab"}`,
		"odd hex":        `{"challenge":"0xabc"}`,
		"wrong type":     `{"owner":5}`,
		"trailing data":  `{} {}`,
		"not json":       `nope`,
		"number for hex": `{"challenge":5}`,
	}
	for name, body := range bad {
		w := do(h, http.MethodPost, "/v1/register", body)
		if w.Code != http.StatusBadRequest || errorOf(t, w).Code != "invalid_request" {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
}

func TestCORS(t *testing.T) {
	h := NewHandler(&stub{})
	for _, r := range routes(&stub{}) {
		// The real request.
		w := do(h, r.method, r.path, "{}")
		if got := w.Header().Get("Access-Control-Allow-Origin"); got != "*" {
			t.Errorf("%s %s: allow-origin %q", r.method, r.path, got)
		}
		// The preflight.
		w = do(h, http.MethodOptions, r.path, "")
		if w.Code != http.StatusNoContent {
			t.Errorf("OPTIONS %s: %d", r.path, w.Code)
		}
		for hdr, want := range map[string]string{
			"Access-Control-Allow-Origin":  "*",
			"Access-Control-Allow-Headers": "Content-Type",
		} {
			if got := w.Header().Get(hdr); got != want {
				t.Errorf("OPTIONS %s: %s = %q", r.path, hdr, got)
			}
		}
		if m := w.Header().Get("Access-Control-Allow-Methods"); !strings.Contains(m, "POST") || !strings.Contains(m, "GET") {
			t.Errorf("OPTIONS %s: methods %q", r.path, m)
		}
		// Credentials are never allowed, on any response.
		if w.Header().Get("Access-Control-Allow-Credentials") != "" {
			t.Errorf("%s allows credentials", r.path)
		}
	}
	// Errors carry the header too, or a browser can't read them.
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, "/v1/nothing"}, {http.MethodPost, "/v1/status"},
	} {
		w := do(h, c.method, c.path, "")
		if w.Header().Get("Access-Control-Allow-Origin") != "*" {
			t.Errorf("%s %s error without CORS", c.method, c.path)
		}
	}
	if w := do(NewHandler(&stub{err: errors.New("x")}), http.MethodGet, "/v1/status", ""); w.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Error("internal error without CORS")
	}
}

func TestNotFound(t *testing.T) {
	h := NewHandler(&stub{})
	for _, path := range []string{"/", "/v1", "/v1/unknown", "/v1/status/extra"} {
		w := do(h, http.MethodGet, path, "")
		if got := errorOf(t, w); w.Code != http.StatusNotFound || got.Code != "not_found" {
			t.Errorf("%s: %d %+v", path, w.Code, got)
		}
	}
}

func TestMethodNotAllowed(t *testing.T) {
	w := do(NewHandler(&stub{}), http.MethodPost, "/v1/status", "")
	if got := errorOf(t, w); w.Code != http.StatusMethodNotAllowed || got.Code != "method_not_allowed" {
		t.Fatalf("%d %+v", w.Code, got)
	}
	if allow := w.Header().Get("Allow"); !strings.HasPrefix(allow, http.MethodGet) {
		t.Fatalf("Allow %q", allow)
	}
}

func TestBodyTooLarge(t *testing.T) {
	w := do(NewHandler(&stub{}), http.MethodPost, "/v1/questions", strings.Repeat("x", maxBody+1))
	if got := errorOf(t, w); w.Code != http.StatusRequestEntityTooLarge || got.Code != "body_too_large" {
		t.Fatalf("%d %+v", w.Code, got)
	}
}

func TestErrorMapping(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"typed", Errorf(http.StatusConflict, "wrong_stage", "not now"), 409, "wrong_stage"},
		{"wrapped typed", errors.Join(errors.New("ctx"), Errorf(http.StatusForbidden, "not_on_list", "no")), 403, "not_on_list"},
		{"internal", errors.New("secret detail"), 500, "internal"},
		{"not implemented", errors.Join(errors.New("context"), notimpl.New("deep.Op")), 501, "not_implemented"},
	}
	for _, c := range cases {
		w := do(NewHandler(&stub{err: c.err}), http.MethodGet, "/v1/status", "")
		got := errorOf(t, w)
		if w.Code != c.status || got.Code != c.code {
			t.Errorf("%s: %d %+v", c.name, w.Code, got)
		}
		if strings.Contains(got.Message, "secret") {
			t.Errorf("%s leaked %q", c.name, got.Message)
		}
	}
}

func TestHexRoundTrip(t *testing.T) {
	b, _ := json.Marshal(Hex{0xab, 0x01})
	if string(b) != `"0xab01"` {
		t.Fatal(string(b))
	}
	b, _ = json.Marshal(Hex(nil))
	if string(b) != `"0x"` {
		t.Fatal(string(b))
	}
}

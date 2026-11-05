// Package api serves the TEE HTTP routes in docs/ARCHITECTURE.md, with the
// error shape from spec/api.md.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"paperseal/tee/internal/notimpl"
)

// maxBody bounds any request body.
const maxBody = 1 << 20

// Backend does the work behind each route. Bodies stay raw and responses stay
// untyped until spec/api.md defines them.
type Backend interface {
	Attestation(ctx context.Context) (any, error)
	Status(ctx context.Context) (any, error)
	RegisterChallenge(ctx context.Context, body []byte) (any, error)
	Register(ctx context.Context, body []byte) (any, error)
	OnboardList(ctx context.Context, body []byte) (any, error)
	Questions(ctx context.Context, body []byte) (any, error)
	Lock(ctx context.Context, body []byte) (any, error)
	Build(ctx context.Context, body []byte) (any, error)
	Outbox(ctx context.Context) (any, error)
	ReleaseChallenge(ctx context.Context, body []byte) (any, error)
	ReleaseShare(ctx context.Context, body []byte) (any, error)
	ReleaseLog(ctx context.Context) (any, error)
}

type handlerFunc func(ctx context.Context, body []byte) (any, error)

type route struct {
	method string
	path   string
	call   handlerFunc
}

func get(f func(context.Context) (any, error)) handlerFunc {
	return func(ctx context.Context, _ []byte) (any, error) { return f(ctx) }
}

func routes(b Backend) []route {
	return []route{
		{http.MethodGet, "/v1/attestation", get(b.Attestation)},
		{http.MethodGet, "/v1/status", get(b.Status)},
		{http.MethodPost, "/v1/register/challenge", b.RegisterChallenge},
		{http.MethodPost, "/v1/register", b.Register},
		{http.MethodPost, "/v1/onboard/list", b.OnboardList},
		{http.MethodPost, "/v1/questions", b.Questions},
		{http.MethodPost, "/v1/lock", b.Lock},
		{http.MethodPost, "/v1/build", b.Build},
		{http.MethodGet, "/v1/outbox", get(b.Outbox)},
		{http.MethodPost, "/v1/release/challenge", b.ReleaseChallenge},
		{http.MethodPost, "/v1/release/share", b.ReleaseShare},
		{http.MethodGet, "/v1/release/log", get(b.ReleaseLog)},
	}
}

// NewHandler returns the routes. Each path is matched without its method so
// that 404 and 405 use the spec error shape, not the mux's plain text.
func NewHandler(b Backend) http.Handler {
	mux := http.NewServeMux()
	for _, r := range routes(b) {
		mux.Handle(r.path, r)
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "no such route")
	})
	return mux
}

func (rt route) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// The verifier page can be hosted anywhere, so public reads allow any
	// origin. Reads carry no credentials and the data is public.
	if rt.method == http.MethodGet {
		w.Header().Set("Access-Control-Allow-Origin", "*")
	}
	if r.Method != rt.method {
		w.Header().Set("Allow", rt.method)
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "use "+rt.method)
		return
	}
	var body []byte
	if rt.method == http.MethodPost {
		var err error
		body, err = io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "body_too_large", "request body is too large")
			return
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, "bad_request", "could not read the request body")
			return
		}
	}
	result, err := rt.call(r.Context(), body)
	if err != nil {
		writeFailure(w, rt.path, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func writeFailure(w http.ResponseWriter, path string, err error) {
	if notimpl.Is(err) {
		var e *notimpl.Error
		errors.As(err, &e)
		writeError(w, http.StatusNotImplemented, "not_implemented", e.Error())
		return
	}
	// Internal errors stay in the log. A client is told only that one happened.
	slog.Error("request failed", "path", path, "err", err)
	writeError(w, http.StatusInternalServerError, "internal", "internal error")
}

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorBody{errorDetail{code, message}})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		slog.Error("encode response", "err", err)
		http.Error(w, `{"error":{"code":"internal","message":"internal error"}}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(append(b, '\n'))
}

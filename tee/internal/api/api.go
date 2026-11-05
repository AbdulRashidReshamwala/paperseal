// Package api serves the TEE HTTP routes in spec/api.md "TEE API", with the
// error shape from "TEE API Errors". Every route allows any origin without
// credentials, because the verifier page can be hosted anywhere and the setter
// and centre apps are served by the board.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"paperseal/tee/internal/notimpl"
	"paperseal/tee/internal/release"
)

// maxBody bounds any request body.
const maxBody = 1 << 20

// Backend does the work behind each route.
type Backend interface {
	Attestation(ctx context.Context) (AttestationResponse, error)
	Status(ctx context.Context) (StatusResponse, error)
	RegisterChallenge(ctx context.Context) (ChallengeResponse, error)
	Register(ctx context.Context, req RegisterRequest) error
	Registrations(ctx context.Context) (RegistrationsResponse, error)
	QuestionChallenge(ctx context.Context) (ChallengeResponse, error)
	Questions(ctx context.Context, req QuestionRequest) (QuestionResponse, error)
	Outbox(ctx context.Context) (OutboxResponse, error)
	ReleaseChallenge(ctx context.Context) (ChallengeResponse, error)
	ReleaseShare(ctx context.Context, req ShareRequest) error
	ReleaseLog(ctx context.Context) (release.Log, error)
}

type handlerFunc func(ctx context.Context, body []byte) (any, error)

type route struct {
	method string
	path   string
	call   handlerFunc
}

func get[Res any](f func(context.Context) (Res, error)) handlerFunc {
	return func(ctx context.Context, _ []byte) (any, error) { return f(ctx) }
}

// post decodes a JSON body into Req. Unknown fields are refused, because the
// bodies are exactly the ones in the spec. A route that takes `{}` also accepts
// an empty body.
func post[Req, Res any](f func(context.Context, Req) (Res, error)) handlerFunc {
	return func(ctx context.Context, body []byte) (any, error) {
		var req Req
		if len(bytes.TrimSpace(body)) == 0 {
			body = []byte("{}")
		}
		dec := json.NewDecoder(bytes.NewReader(body))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil {
			return nil, Errorf(http.StatusBadRequest, "invalid_request", "request body: "+err.Error())
		}
		if _, err := dec.Token(); !errors.Is(err, io.EOF) {
			return nil, Errorf(http.StatusBadRequest, "invalid_request", "request body has trailing data")
		}
		return f(ctx, req)
	}
}

// ok adapts a route with no response body to the `{}` the spec returns.
func ok[Req any](f func(context.Context, Req) error) func(context.Context, Req) (struct{}, error) {
	return func(ctx context.Context, req Req) (struct{}, error) { return struct{}{}, f(ctx, req) }
}

func routes(b Backend) []route {
	return []route{
		{http.MethodGet, "/v1/attestation", get(b.Attestation)},
		{http.MethodGet, "/v1/status", get(b.Status)},
		{http.MethodPost, "/v1/register/challenge", post(func(ctx context.Context, _ struct{}) (ChallengeResponse, error) {
			return b.RegisterChallenge(ctx)
		})},
		{http.MethodPost, "/v1/register", post(ok(b.Register))},
		{http.MethodGet, "/v1/registrations", get(b.Registrations)},
		{http.MethodPost, "/v1/questions/challenge", post(func(ctx context.Context, _ struct{}) (ChallengeResponse, error) {
			return b.QuestionChallenge(ctx)
		})},
		{http.MethodPost, "/v1/questions", post(b.Questions)},
		{http.MethodGet, "/v1/outbox", get(b.Outbox)},
		{http.MethodPost, "/v1/release/challenge", post(func(ctx context.Context, _ struct{}) (ChallengeResponse, error) {
			return b.ReleaseChallenge(ctx)
		})},
		{http.MethodPost, "/v1/release/share", post(ok(b.ReleaseShare))},
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
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		writeError(w, http.StatusNotFound, "not_found", "no such route")
	})
	return mux
}

// cors allows any origin and never credentials: no Access-Control-Allow-Credentials
// is sent, so a browser won't attach cookies or HTTP auth to these requests.
func cors(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Content-Type")
	h.Set("Access-Control-Max-Age", "86400")
}

func (rt route) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == http.MethodOptions {
		w.Header().Set("Allow", rt.method+", OPTIONS")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != rt.method {
		w.Header().Set("Allow", rt.method+", OPTIONS")
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

// Error is a failure with its response. Backends return it for anything a
// client caused or can act on.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Errorf returns an Error.
func Errorf(status int, code, message string) *Error { return &Error{status, code, message} }

func writeFailure(w http.ResponseWriter, path string, err error) {
	var apiErr *Error
	if errors.As(err, &apiErr) {
		writeError(w, apiErr.Status, apiErr.Code, apiErr.Message)
		return
	}
	var e *notimpl.Error
	if errors.As(err, &e) {
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

package attestation

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestLauncherMissingSocketIsUnattested(t *testing.T) {
	l := Launcher{Socket: filepath.Join(t.TempDir(), "missing.sock")}
	tok, err := l.Token(context.Background(), TokenOIDC, "paperseal", "nonce")
	if !errors.Is(err, ErrUnattested) {
		t.Fatalf("want ErrUnattested, got %v", err)
	}
	if tok.Raw != "" {
		t.Fatal("a token was produced")
	}
}

// serve stands in for the launcher on a Unix socket. It is a test double of
// Google's service: it only checks that the request has the documented shape.
func serve(t *testing.T, h http.HandlerFunc) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "ps")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "t.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: h}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return sock
}

func TestLauncherRequestShape(t *testing.T) {
	var got tokenRequest
	var path, method, ctype string
	sock := serve(t, func(w http.ResponseWriter, r *http.Request) {
		path, method, ctype = r.URL.Path, r.Method, r.Header.Get("Content-Type")
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &got)
		w.Write([]byte("aaa.bbb.ccc\n"))
	})
	tok, err := Launcher{Socket: sock}.Token(context.Background(), TokenPKI, "paperseal", "abcdef0123456789")
	if err != nil {
		t.Fatal(err)
	}
	if tok.Raw != "aaa.bbb.ccc" || tok.Type != TokenPKI {
		t.Fatalf("token %+v", tok)
	}
	if method != "POST" || path != "/v1/token" || ctype != "application/json" {
		t.Fatalf("request %s %s %s", method, path, ctype)
	}
	if got.Audience != "paperseal" || got.TokenType != "PKI" || len(got.Nonces) != 1 || got.Nonces[0] != "abcdef0123456789" {
		t.Fatalf("body %+v", got)
	}
}

func TestLauncherErrors(t *testing.T) {
	sock := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusBadRequest)
	})
	if _, err := (Launcher{Socket: sock}).Token(context.Background(), TokenOIDC, "a", "n"); err == nil {
		t.Fatal("accepted a 400")
	}
	sock = serve(t, func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("not a jwt")) })
	if _, err := (Launcher{Socket: sock}).Token(context.Background(), TokenOIDC, "a", "n"); err == nil {
		t.Fatal("accepted a non-JWT")
	}
	if _, err := (Launcher{}).Token(context.Background(), "BAD", "a", "n"); err == nil {
		t.Fatal("accepted an unknown token type")
	}
}

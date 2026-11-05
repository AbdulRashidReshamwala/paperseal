package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net"
	"net/http"
	"testing"
	"time"

	"paperseal/tee/internal/api"
)

// statusOnly serves /v1/status; any other method panics through the nil
// embedded interface, which this test never reaches.
type statusOnly struct{ api.Backend }

func (statusOnly) Status(context.Context) (api.StatusResponse, error) {
	return api.StatusResponse{Stage: "submit"}, nil
}

func TestServesStatusOverTLS(t *testing.T) {
	cfg, err := selfSignedConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MinVersion != tls.VersionTLS12 {
		t.Errorf("min version %x", cfg.MinVersion)
	}
	leaf, err := x509.ParseCertificate(cfg.Certificates[0].Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(leaf)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: api.NewHandler(statusOnly{}), TLSConfig: cfg, ReadHeaderTimeout: time.Second}
	go srv.ServeTLS(ln, "", "")
	defer srv.Close()

	// Verify against the generated certificate for the production name.
	client := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{RootCAs: pool, ServerName: certHost},
		DialContext: func(ctx context.Context, n, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, n, ln.Addr().String())
		},
	}}
	resp, err := client.Get("https://" + certHost + "/v1/status")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.TLS == nil || resp.StatusCode != 200 {
		t.Fatalf("status %d, tls %v", resp.StatusCode, resp.TLS)
	}
	var got api.StatusResponse
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil || got.Stage != "submit" {
		t.Fatalf("got %+v, %v", got, err)
	}

	// Plain HTTP must not work on the same port.
	if r, err := http.Get("http://" + ln.Addr().String() + "/v1/status"); err == nil && r.StatusCode == 200 {
		t.Error("plain HTTP answered")
	}
}

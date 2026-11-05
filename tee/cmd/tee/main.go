// Command tee is the Paper Seal Confidential Space workload.
package main

import (
	"context"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"paperseal/tee/internal/api"
	"paperseal/tee/internal/attestation"
	"paperseal/tee/internal/chainread"
	"paperseal/tee/internal/lifecycle"
	"paperseal/tee/internal/settings"
	"paperseal/tee/internal/storage"
	"paperseal/tee/internal/timelock"
)

// listenAddr is fixed, not a flag, because the attestation check compares the
// arguments to the on-chain settings, and the Dockerfile EXPOSEs this port.
const listenAddr = ":8080"

// stepEvery is how often the lifecycle looks for progress. A quicknet round is
// 3 seconds, so a stage starts within a round or two of its drand round.
const stepEvery = 2 * time.Second

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "tee:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	exam, err := settings.Parse(args)
	if err != nil {
		return err
	}
	roots, err := chainread.LoadRoots(chainread.RootsPath)
	if err != nil {
		return err
	}
	machine, err := newMachine(exam, roots, os.Getenv("STORAGE_BUCKET"), os.Getenv("STORAGE_DIR"))
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go machine.Run(ctx, stepEvery)

	// HTTPS with a throwaway self-signed certificate, so Cloudflare's Full mode
	// never falls back to plain HTTP. The certificate has no trust role: apps
	// trust the attestation token and HPKE, not this transport.
	tlsConfig, err := selfSignedConfig()
	if err != nil {
		return err
	}
	srv := &http.Server{
		Addr:              listenAddr,
		TLSConfig:         tlsConfig,
		Handler:           api.NewHandler(machine),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
	}
	failed := make(chan error, 1)
	go func() { failed <- srv.ListenAndServeTLS("", "") }()
	slog.Info("listening", "addr", listenAddr, "examId", "0x"+hex.EncodeToString(exam.ExamID[:]))

	select {
	case err := <-failed:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// newMachine wires the real collaborators: the launcher, drand, the chain over
// TLS with the image's roots, and storage.
func newMachine(exam settings.Exam, roots *x509.CertPool, bucket, dir string) (*lifecycle.Machine, error) {
	keys, err := attestation.NewKeys(exam.ExamID)
	if err != nil {
		return nil, err
	}
	verifier, err := attestation.NewVerifier()
	if err != nil {
		return nil, err
	}
	quicknet, err := timelock.QuickNet()
	if err != nil {
		return nil, err
	}
	store, err := newStore(bucket, dir, roots)
	if err != nil {
		return nil, err
	}
	return lifecycle.New(lifecycle.Config{
		Exam:     exam,
		Keys:     keys,
		Tokens:   attestation.Launcher{},
		Verifier: verifier,
		Chain:    chainread.New(exam, roots),
		Beacon:   timelock.NewHTTPBeacon(quicknet, timelock.DefaultRelays, httpClient(roots)),
		Sealer:   timelock.NewSealer(quicknet),
		Store:    store,
		Bucket:   bucket,
	}), nil
}

// httpClient trusts only the image's roots, as chain reads do.
func httpClient(roots *x509.CertPool) *http.Client {
	c := chainread.HTTPClient(roots)
	c.CheckRedirect = nil
	return c
}

// newStore picks storage from the environment: a public bucket in production,
// or a local folder for local runs. Exactly one must be set.
func newStore(bucket, dir string, roots *x509.CertPool) (storage.Store, error) {
	switch {
	case bucket != "" && dir != "":
		return nil, errors.New("set one of STORAGE_BUCKET and STORAGE_DIR, not both")
	case bucket != "":
		return &storage.Bucket{Name: bucket, Client: httpClient(roots)}, nil
	case dir != "":
		return storage.Dir{Root: dir}, nil
	}
	return nil, errors.New("set STORAGE_BUCKET, or STORAGE_DIR for a local run")
}

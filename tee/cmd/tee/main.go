// Command tee is the Paper Seal Confidential Space workload.
package main

import (
	"context"
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
	"paperseal/tee/internal/settings"
)

// listenAddr is fixed, not a flag, because the attestation check compares the
// arguments to the on-chain settings, and the Dockerfile EXPOSEs this port.
const listenAddr = ":8080"

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

	srv := &http.Server{
		Addr:              listenAddr,
		Handler:           api.NewHandler(api.Unimplemented{}),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	failed := make(chan error, 1)
	go func() { failed <- srv.ListenAndServe() }()
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

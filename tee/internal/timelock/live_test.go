//go:build drandlive

package timelock_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"paperseal/tee/internal/spec"
	"paperseal/tee/internal/timelock"
)

// Run on demand against the real quicknet:
//
//	go test -tags drandlive -run Live ./internal/timelock
//
// It is not part of go test ./..., because it needs the network.
func TestLiveQuickNet(t *testing.T) {
	c, err := timelock.QuickNet()
	if err != nil {
		t.Fatal(err)
	}
	b := timelock.NewHTTPBeacon(c, timelock.DefaultRelays, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	latest, err := b.Latest(ctx)
	if err != nil {
		t.Fatalf("latest: %v", err)
	}
	t.Logf("latest verified round %d", latest)
	if latest < 1_000_000 {
		t.Fatalf("implausible round %d", latest)
	}
	// An old round verifies against drand.publicKey from the constants.
	if _, err := b.Randomness(ctx, 1); err != nil {
		t.Fatalf("round 1: %v", err)
	}
	// The round that matches the wall clock is near latest.
	want := uint64(time.Now().Unix()-spec.C.Drand.GenesisTime)/uint64(spec.C.Drand.PeriodSeconds) + 1
	if latest+3 < want || latest > want+3 {
		t.Errorf("latest %d far from wall clock round %d", latest, want)
	}
	// A far future round isn't published.
	if _, err := b.Randomness(ctx, latest+1_000_000); !errors.Is(err, timelock.ErrNotPublished) {
		t.Errorf("future round: %v", err)
	}
	// Sealing works against the real key.
	if _, err := timelock.NewSealer(c).Seal(ctx, latest+1000, []byte("live")); err != nil {
		t.Errorf("seal: %v", err)
	}
}

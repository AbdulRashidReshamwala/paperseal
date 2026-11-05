package timelock_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"paperseal/tee/internal/timelock"
	"paperseal/tee/internal/timelock/timelocktest"
)

func TestSealThenOpenAtRound(t *testing.T) {
	c := timelocktest.New(t)
	armoured, err := timelock.NewSealer(c.Chain).Seal(context.Background(), 50, []byte("K_pub bytes"))
	if err != nil {
		t.Fatal(err)
	}
	// Not before the round.
	if _, err := c.OpenAt(t, armoured, 49); err == nil {
		t.Fatal("opened before its round")
	}
	// At the round, with the chain's own signature.
	got, err := c.OpenAt(t, armoured, 50)
	if err != nil || string(got) != "K_pub bytes" {
		t.Fatalf("open: %q %v", got, err)
	}
	// Sealed to another round, the round-50 signature doesn't open it.
	other, _ := timelock.NewSealer(c.Chain).Seal(context.Background(), 51, []byte("x"))
	if _, err := c.OpenAt(t, other, 50); err == nil {
		t.Fatal("opened a later round")
	}
}

// relay serves rounds up to a limit from a test chain, like a drand relay.
func relay(t *testing.T, c *timelocktest.Chain, limit *atomic.Uint64, tamper func(r *timelocktest.Round)) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(r.URL.Path, "/")
		if len(parts) != 4 || parts[1] != c.Hash || parts[2] != "public" {
			http.NotFound(w, r)
			return
		}
		var round uint64
		if parts[3] == "latest" {
			round = limit.Load()
		} else {
			n, err := strconv.ParseUint(parts[3], 10, 64)
			if err != nil || n > limit.Load() || n == 0 {
				http.Error(w, "not yet", http.StatusNotFound)
				return
			}
			round = n
		}
		out := c.Sign(t, round)
		if tamper != nil {
			tamper(&out)
		}
		json.NewEncoder(w).Encode(out)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestBeaconVerifiesRounds(t *testing.T) {
	c := timelocktest.New(t)
	var limit atomic.Uint64
	limit.Store(10)
	good := relay(t, c, &limit, nil)
	b := timelock.NewHTTPBeacon(c.Chain, []string{good.URL}, good.Client())
	ctx := context.Background()

	rnd, err := b.Randomness(ctx, 7)
	if err != nil || len(rnd) != 32 {
		t.Fatalf("round 7: %v", err)
	}
	if _, err := b.Randomness(ctx, 11); !errors.Is(err, timelock.ErrNotPublished) {
		t.Fatalf("future round: want ErrNotPublished, got %v", err)
	}
	limit.Store(11)
	if _, err := b.Randomness(ctx, 11); err != nil {
		t.Fatalf("round 11 once published: %v", err)
	}
	if latest, err := b.Latest(ctx); err != nil || latest != 11 {
		t.Fatalf("latest: %d %v", latest, err)
	}
}

func TestBeaconRefusesWrongAndForgedRounds(t *testing.T) {
	c := timelocktest.New(t)
	var limit atomic.Uint64
	limit.Store(100)
	ctx := context.Background()
	cases := map[string]func(r *timelocktest.Round){
		"a different round": func(r *timelocktest.Round) { *r = c.Sign(t, r.Round+1) },
		"a bad signature": func(r *timelocktest.Round) {
			other := timelocktest.New(t)
			*r = other.Sign(t, r.Round)
		},
		"bad randomness": func(r *timelocktest.Round) { r.Randomness = strings.Repeat("00", 32) },
		"no signature":   func(r *timelocktest.Round) { r.Signature = "" },
	}
	for name, tamper := range cases {
		t.Run(name, func(t *testing.T) {
			srv := relay(t, c, &limit, tamper)
			b := timelock.NewHTTPBeacon(c.Chain, []string{srv.URL}, srv.Client())
			_, err := b.Randomness(ctx, 50)
			if err == nil || errors.Is(err, timelock.ErrNotPublished) {
				t.Fatalf("want a hard error, got %v", err)
			}
		})
	}
}

func TestBeaconFallsBackToAnotherRelay(t *testing.T) {
	c := timelocktest.New(t)
	var limit atomic.Uint64
	limit.Store(100)
	bad := relay(t, c, &limit, func(r *timelocktest.Round) { r.Signature = "00" })
	good := relay(t, c, &limit, nil)
	b := timelock.NewHTTPBeacon(c.Chain, []string{bad.URL, good.URL}, nil)
	if _, err := b.Randomness(context.Background(), 5); err != nil {
		t.Fatalf("fallback: %v", err)
	}
	// A relay that is down yields an error, not "not published".
	down := httptest.NewServer(http.NotFoundHandler())
	url := down.URL
	down.Close()
	b = timelock.NewHTTPBeacon(c.Chain, []string{url}, nil)
	if _, err := b.Randomness(context.Background(), 5); err == nil || errors.Is(err, timelock.ErrNotPublished) {
		t.Fatalf("unreachable relay: %v", err)
	}
}

func TestFakeBeacon(t *testing.T) {
	var f timelocktest.Fake
	ctx := context.Background()
	if _, err := f.Randomness(ctx, 1); !errors.Is(err, timelock.ErrNotPublished) {
		t.Fatal("unpublished round returned")
	}
	f.Set(5)
	if _, err := f.Randomness(ctx, 5); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Randomness(ctx, 6); !errors.Is(err, timelock.ErrNotPublished) {
		t.Fatal("future round returned")
	}
}

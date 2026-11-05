package timelock

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DefaultRelays are public drand HTTP relays. They are untrusted: every round
// is verified against the chain's public key.
var DefaultRelays = []string{"https://api.drand.sh", "https://drand.cloudflare.com"}

// HTTPBeacon is the real Beacon: rounds from drand HTTP relays, each verified.
type HTTPBeacon struct {
	chain  Chain
	relays []string
	client *http.Client

	mu       sync.Mutex
	verified map[uint64][]byte
}

var _ Beacon = (*HTTPBeacon)(nil)

// NewHTTPBeacon reads from the relays in order. A nil client gets a default with
// a timeout. Pass one with the image's root certificates in production.
func NewHTTPBeacon(c Chain, relays []string, client *http.Client) *HTTPBeacon {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &HTTPBeacon{chain: c, relays: relays, client: client, verified: map[uint64][]byte{}}
}

// Randomness returns a verified round, or ErrNotPublished when every relay says
// it doesn't exist yet. A relay that serves a different round or a bad
// signature is an error, not "not yet".
func (b *HTTPBeacon) Randomness(ctx context.Context, round uint64) ([]byte, error) {
	b.mu.Lock()
	r, ok := b.verified[round]
	b.mu.Unlock()
	if ok {
		return r, nil
	}
	got, err := b.fetch(ctx, strconv.FormatUint(round, 10), round)
	if err != nil {
		return nil, err
	}
	b.mu.Lock()
	b.verified[round] = got.randomness
	b.mu.Unlock()
	return got.randomness, nil
}

// Latest returns the newest verified round.
func (b *HTTPBeacon) Latest(ctx context.Context) (uint64, error) {
	got, err := b.fetch(ctx, "latest", 0)
	if err != nil {
		return 0, err
	}
	return got.round, nil
}

type fetched struct {
	round      uint64
	randomness []byte
}

// fetch asks each relay in turn. wantRound is zero for "latest".
func (b *HTTPBeacon) fetch(ctx context.Context, which string, wantRound uint64) (fetched, error) {
	var errs []error
	allMissing := true
	for _, relay := range b.relays {
		url := strings.TrimRight(relay, "/") + "/" + b.chain.Hash + "/public/" + which
		beacon, status, err := b.get(ctx, url)
		switch {
		case err != nil:
			allMissing = false
			errs = append(errs, err)
			continue
		case status == http.StatusNotFound || status == http.StatusTooEarly:
			errs = append(errs, fmt.Errorf("timelock: %s: round not available (%d)", relay, status))
			continue
		case status != http.StatusOK:
			allMissing = false
			errs = append(errs, fmt.Errorf("timelock: %s: status %d", relay, status))
			continue
		}
		if wantRound != 0 && beacon.Round != wantRound {
			allMissing = false
			errs = append(errs, fmt.Errorf("timelock: %s served round %d, asked for %d", relay, beacon.Round, wantRound))
			continue
		}
		rnd, err := b.chain.verify(beacon)
		if err != nil {
			allMissing = false
			errs = append(errs, fmt.Errorf("%s: %w", relay, err))
			continue
		}
		return fetched{beacon.Round, rnd}, nil
	}
	if allMissing && len(errs) > 0 && wantRound != 0 {
		return fetched{}, ErrNotPublished
	}
	return fetched{}, errors.Join(errs...)
}

func (b *HTTPBeacon) get(ctx context.Context, url string) (beaconJSON, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return beaconJSON{}, 0, err
	}
	resp, err := b.client.Do(req)
	if err != nil {
		return beaconJSON{}, 0, fmt.Errorf("timelock: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if err != nil {
		return beaconJSON{}, 0, fmt.Errorf("timelock: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return beaconJSON{}, resp.StatusCode, nil
	}
	var out beaconJSON
	if err := json.Unmarshal(body, &out); err != nil {
		return beaconJSON{}, 0, fmt.Errorf("timelock: relay response: %w", err)
	}
	return out, resp.StatusCode, nil
}

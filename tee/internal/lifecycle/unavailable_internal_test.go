package lifecycle

import (
	"errors"
	"fmt"
	"net/http"
	"testing"

	"paperseal/tee/internal/api"
	"paperseal/tee/internal/timelock"
)

// A relay outage is retryable: 503 stale_beacon, not a 500 internal.
func TestUnavailableBeaconIsStaleBeacon(t *testing.T) {
	err := releaseError(fmt.Errorf("check rounds: %w", timelock.ErrUnavailable))
	var apiErr *api.Error
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusServiceUnavailable || apiErr.Code != "stale_beacon" {
		t.Fatalf("want 503 stale_beacon, got %v", err)
	}
}

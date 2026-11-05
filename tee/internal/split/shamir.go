package split

import (
	"errors"
	"fmt"

	"github.com/hashicorp/vault/shamir"

	"paperseal/tee/internal/spec"
)

// ErrTooFewShares is returned below the threshold. shamir.Combine has no
// threshold of its own and would return wrong bytes without an error.
var ErrTooFewShares = errors.New("split: fewer shares than the threshold")

// SplitShares cuts K_priv into one share per key holder.
func SplitShares(kPriv []byte) ([][]byte, error) {
	if err := checkKeyLen(kPriv); err != nil {
		return nil, err
	}
	shares, err := shamir.Split(kPriv, spec.C.Threshold.Holders, spec.C.Threshold.Required)
	if err != nil {
		return nil, fmt.Errorf("split: shamir split: %w", err)
	}
	return shares, nil
}

// CombineShares rebuilds K_priv from at least the threshold of shares. A wrong
// share gives wrong bytes, not an error, so callers must check each share
// against its published hash first.
func CombineShares(shares [][]byte) ([]byte, error) {
	if len(shares) < spec.C.Threshold.Required {
		return nil, fmt.Errorf("%w: have %d, need %d", ErrTooFewShares, len(shares), spec.C.Threshold.Required)
	}
	kPriv, err := shamir.Combine(shares)
	if err != nil {
		return nil, fmt.Errorf("split: shamir combine: %w", err)
	}
	return kPriv, nil
}

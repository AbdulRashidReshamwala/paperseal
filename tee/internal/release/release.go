// Package release collects shares at unlock and delivers K_priv to centres.
// It keeps no long-term state: if the instance stops, holders resubmit.
package release

import (
	"context"

	"paperseal/tee/internal/notimpl"
)

// Share is one holder's release, encrypted to the instance key.
type Share struct {
	HolderID  []byte
	Encrypted []byte
	Signature []byte
}

// Progress is the public release status. It never contains a share.
type Progress struct {
	Released [][]byte // Holder IDs
	Required int
}

// Collector checks shares and rebuilds K_priv once it has enough.
type Collector interface {
	Challenge(ctx context.Context, holderID []byte) ([]byte, error)
	Submit(ctx context.Context, s Share) error
	Progress(ctx context.Context) (Progress, error)
	Log(ctx context.Context) ([]byte, error)
}

// Unlock is the stub Collector.
type Unlock struct{}

// Challenge is not implemented.
func (Unlock) Challenge(context.Context, []byte) ([]byte, error) {
	return nil, notimpl.New("release.Unlock.Challenge")
}

// Submit is not implemented.
func (Unlock) Submit(context.Context, Share) error { return notimpl.New("release.Unlock.Submit") }

// Progress is not implemented.
func (Unlock) Progress(context.Context) (Progress, error) {
	return Progress{}, notimpl.New("release.Unlock.Progress")
}

// Log is not implemented.
func (Unlock) Log(context.Context) ([]byte, error) { return nil, notimpl.New("release.Unlock.Log") }

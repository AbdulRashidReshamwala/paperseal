// Package storage writes files to public storage. Build goes on-chain only
// after these writes succeed, so a crash can't leave a committed paper that
// nobody can open.
package storage

import (
	"context"

	"paperseal/tee/internal/notimpl"
)

// Store writes public files.
type Store interface {
	Put(ctx context.Context, name string, data []byte) error
}

// Bucket is the stub Store.
type Bucket struct{}

// Put is not implemented.
func (Bucket) Put(context.Context, string, []byte) error { return notimpl.New("storage.Bucket.Put") }

// Package storage reads and writes public files. Build goes on-chain only
// after these writes succeed, so a crash can't leave a committed paper that
// nobody can open.
package storage

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// ErrNotFound is returned by Get for a missing file.
var ErrNotFound = errors.New("storage: not found")

// Store reads and writes public files. Names are slash-separated paths like
// "0x<examId>/paper.bin".
type Store interface {
	Put(ctx context.Context, name string, data []byte) error
	Get(ctx context.Context, name string) ([]byte, error)
}

// checkName refuses names that could leave the store or that clean to another
// name.
func checkName(name string) error {
	if name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, "\\") ||
		strings.ContainsRune(name, 0) || path.Clean(name) != name || name == "." || strings.HasPrefix(name, "../") {
		return fmt.Errorf("storage: bad file name %q", name)
	}
	return nil
}

// Dir is a Store on a local folder, for STORAGE_DIR.
type Dir struct{ Root string }

var _ Store = Dir{}

// Put writes the file whole or not at all.
func (d Dir) Put(_ context.Context, name string, data []byte) error {
	if err := checkName(name); err != nil {
		return err
	}
	full := filepath.Join(d.Root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return fmt.Errorf("storage: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(full), ".put-*")
	if err != nil {
		return fmt.Errorf("storage: %w", err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("storage: %w", err)
	}
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return fmt.Errorf("storage: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("storage: %w", err)
	}
	if err := os.Rename(tmp.Name(), full); err != nil {
		return fmt.Errorf("storage: %w", err)
	}
	return nil
}

// Get reads a file.
func (d Dir) Get(_ context.Context, name string) ([]byte, error) {
	if err := checkName(name); err != nil {
		return nil, err
	}
	b, err := os.ReadFile(filepath.Join(d.Root, filepath.FromSlash(name)))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("storage: %w", err)
	}
	return b, nil
}

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
	// Put creates a file. A bucket never replaces what Put wrote.
	Put(ctx context.Context, name string, data []byte) error
	// Replace writes a file that may already exist, for the unlock files only,
	// see IsUnlockFile. Anything else is refused.
	Replace(ctx context.Context, name string, data []byte) error
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

// IsUnlockFile reports whether name, which starts with the exam folder, is one
// of the files written at unlock: key-priv/*, key-priv.tlock, release-log.json
// and release-token.jwt. A new Unlock instance may have to replace them, because
// HPKE, the timelock and signatures differ on every run. Each is authenticated
// by its own means, and the Build commits to none of them. Every file in the
// manifest stays create-only.
func IsUnlockFile(name string) bool {
	_, rel, ok := strings.Cut(name, "/")
	if !ok {
		return false
	}
	switch rel {
	case "key-priv.tlock", "release-log.json", "release-token.jwt":
		return true
	}
	rest, ok := strings.CutPrefix(rel, "key-priv/")
	return ok && rest != "" && !strings.Contains(rest, "/")
}

// Dir is a Store on a local folder, for STORAGE_DIR.
type Dir struct{ Root string }

var _ Store = Dir{}

// syncFile and syncDir are replaced in tests, to see the order of the calls.
var (
	syncFile = func(f *os.File) error { return f.Sync() }
	syncDir  = func(path string) error {
		dir, err := os.Open(path)
		if err != nil {
			return err
		}
		defer dir.Close()
		return dir.Sync()
	}
)

// Put writes the file whole or not at all, and durably: the data is synced
// before the rename, and the folder after it, so a crash can't leave a name
// that points at nothing.
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
	if err := syncFile(tmp); err != nil {
		tmp.Close()
		return fmt.Errorf("storage: sync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("storage: %w", err)
	}
	if err := os.Rename(tmp.Name(), full); err != nil {
		return fmt.Errorf("storage: %w", err)
	}
	if err := syncDir(filepath.Dir(full)); err != nil {
		return fmt.Errorf("storage: sync folder: %w", err)
	}
	return nil
}

// Replace writes an unlock file, replacing any earlier one.
func (d Dir) Replace(ctx context.Context, name string, data []byte) error {
	if err := checkName(name); err != nil {
		return err
	}
	if !IsUnlockFile(name) {
		return fmt.Errorf("storage: %s is not an unlock file and can't be replaced", name)
	}
	return d.Put(ctx, name, data)
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

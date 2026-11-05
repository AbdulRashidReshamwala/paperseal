// Package notimpl is the typed error for unfinished code. A stub returns it
// instead of faking a check, signature or decryption.
package notimpl

import "errors"

// Error reports an operation that is not implemented yet.
type Error struct {
	Op string
}

func (e *Error) Error() string { return e.Op + ": not implemented" }

// New returns an Error for op.
func New(op string) error { return &Error{Op: op} }

// Is reports whether err is, or wraps, an Error.
func Is(err error) bool {
	var target *Error
	return errors.As(err, &target)
}

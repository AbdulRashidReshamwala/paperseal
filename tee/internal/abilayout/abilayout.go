// Package abilayout checks the layout of ABI-encoded dynamic arrays from the raw
// bytes, before any decoder runs. ABI offsets let many elements point at one
// large value, so a small input can decode into a huge one. These checks make
// each byte belong to at most one element, which bounds what a decoder can
// build by the input length. Nothing here allocates in proportion to a claimed
// length: it reads words in place and never copies.
package abilayout

import (
	"errors"
	"fmt"
)

// ErrLayout means the offsets or lengths in the bytes break the layout rules.
var ErrLayout = errors.New("abilayout: bad layout")

func fail(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrLayout, fmt.Sprintf(format, a...))
}

// Word reads the 32-byte big-endian number at pos. It must fit in 63 bits, which
// is far beyond any size this package accepts.
func Word(b []byte, pos int) (uint64, error) {
	if pos < 0 || len(b)-pos < 32 {
		return 0, fail("word at %d runs past the end", pos)
	}
	var n uint64
	for i, c := range b[pos : pos+32] {
		if i < 24 {
			if c != 0 {
				return 0, fail("word at %d is too large", pos)
			}
			continue
		}
		n = n<<8 | uint64(c)
	}
	if n >= 1<<63 {
		return 0, fail("word at %d is too large", pos)
	}
	return n, nil
}

// Bytes checks a `bytes` or `string` value whose length word is at `at`. The
// length and its zero-padded data must end at or before limit. It returns the
// end of the padded data.
func Bytes(b []byte, at, limit int) (int, error) {
	if limit > len(b) {
		limit = len(b)
	}
	n, err := Word(b, at)
	if err != nil {
		return 0, err
	}
	room := limit - (at + 32)
	if room < 0 || n > uint64(room) {
		return 0, fail("value at %d is longer than the %d bytes left", at, max(room, 0))
	}
	padded := (int(n) + 31) &^ 31
	if padded > room {
		return 0, fail("padded value at %d runs past its limit", at)
	}
	return at + 32 + padded, nil
}

// Elem checks one array element that starts at start and must end at or before
// limit. It returns where the element ends.
type Elem func(start, limit int) (end int, err error)

// Array checks the array whose length word is at pos, with all of it ending at
// or before limit. Its element offsets are relative to the word after the
// length. They must:
//   - number n, with n*32 fitting in the space left,
//   - start right after that head, which means the first offset is n*32,
//   - be multiples of 32 and strictly increasing,
//   - leave each element ending at or before the next one starts, and the last
//     at or before limit, which elem checks.
//
// It returns the array's length and where its last element ends.
func Array(b []byte, pos, limit int, elem Elem) (n int, end int, err error) {
	if limit > len(b) {
		limit = len(b)
	}
	count, err := Word(b, pos)
	if err != nil {
		return 0, 0, err
	}
	base := pos + 32
	room := limit - base
	if room < 0 || count > uint64(room)/32 {
		return 0, 0, fail("array at %d claims %d elements, more than fit", pos, count)
	}
	n = int(count)
	end = base + 32*n
	prev := -1
	for i := 0; i < n; i++ {
		off, err := Word(b, base+32*i)
		if err != nil {
			return 0, 0, err
		}
		if off > uint64(room) || off%32 != 0 {
			return 0, 0, fail("element %d offset %d is outside the array", i, off)
		}
		if i == 0 && int(off) != 32*n {
			return 0, 0, fail("first offset %d does not follow the head of %d bytes", off, 32*n)
		}
		if int(off) <= prev {
			return 0, 0, fail("element %d offset %d does not increase", i, off)
		}
		prev = int(off)
		next := limit
		if i+1 < n {
			nextOff, err := Word(b, base+32*(i+1))
			if err != nil {
				return 0, 0, err
			}
			if nextOff > uint64(room) {
				return 0, 0, fail("element %d offset %d is outside the array", i+1, nextOff)
			}
			next = base + int(nextOff)
		}
		start := base + int(off)
		if start >= next {
			return 0, 0, fail("element %d has no room before the next", i)
		}
		e, err := elem(start, next)
		if err != nil {
			return 0, 0, fmt.Errorf("element %d: %w", i, err)
		}
		if e > next {
			return 0, 0, fail("element %d ends past the next element", i)
		}
		end = e
	}
	return n, end, nil
}

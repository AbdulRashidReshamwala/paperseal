package approvedlist

import (
	"bytes"
	"errors"
	"runtime"
	"strings"
	"testing"

	"paperseal/tee/internal/spec"
)

func many(t *testing.T, n int) []byte {
	t.Helper()
	k := key(t, 1)
	var tuples [][]byte
	for range n {
		tuples = append(tuples, tuple(1, k, nil, "x"))
	}
	return handList(tuples...)
}

func TestByteCap(t *testing.T) {
	cap := spec.C.Limits.EntriesBytes
	valid := raw(1, key(t, 1), nil, "x")
	atCap := append(bytes.Clone(valid), make([]byte, cap-len(valid))...)
	if _, err := Decode(atCap); errors.Is(err, ErrTooLarge) {
		t.Fatalf("exactly at the cap was refused for size: %v", err)
	}
	if _, err := Decode(append(atCap, 0)); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("one over: %v", err)
	}
}

func TestEntryAndOwnerLimits(t *testing.T) {
	lim := spec.C.Limits
	// The list fails its other rules, so only the limit decides ErrLimit.
	if _, err := Decode(many(t, lim.Entries)); errors.Is(err, ErrLimit) || errors.Is(err, ErrMalformed) {
		t.Fatalf("exactly %d entries: %v", lim.Entries, err)
	}
	if _, err := Decode(many(t, lim.Entries+1)); !errors.Is(err, ErrLimit) {
		t.Fatalf("one over entries: %v", err)
	}
	k := key(t, 1)
	owner := func(n int) []byte { return raw(2, k, k, strings.Repeat("o", n)) }
	if _, err := Decode(owner(lim.OwnerBytes)); errors.Is(err, ErrLimit) {
		t.Fatalf("owner at the limit: %v", err)
	}
	if _, err := Decode(owner(lim.OwnerBytes + 1)); !errors.Is(err, ErrLimit) {
		t.Fatalf("owner one over: %v", err)
	}
}

// allocated reports the heap bytes f allocates, after inputs are built.
func allocated(f func()) uint64 {
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	f()
	runtime.ReadMemStats(&after)
	return after.TotalAlloc - before.TotalAlloc
}

// Many entries share one tuple holding a large owner. A plain decode would copy
// the owner once per entry, so a small input would become a huge value.
func TestSharedOffsetAttackFailsCheaply(t *testing.T) {
	const n = 500
	k := key(t, 1)
	big := tuple(1, k, nil, strings.Repeat("x", spec.C.Limits.EntriesBytes-32*n-1024))
	out := append(word(0x20), word(n)...)
	for range n {
		out = append(out, word(32*n)...)
	}
	out = append(out, big...)
	if len(out) > spec.C.Limits.EntriesBytes {
		t.Fatalf("attack is over the cap by itself: %d", len(out))
	}
	var err error
	got := allocated(func() { _, err = Decode(out) })
	if !errors.Is(err, ErrMalformed) {
		t.Fatalf("got %v", err)
	}
	if got > 16<<10 {
		t.Fatalf("allocated %d bytes for a %d byte input", got, len(out))
	}
}

func TestLayoutRejections(t *testing.T) {
	k := key(t, 1)
	a, b := tuple(1, k, nil, "x"), tuple(1, k, nil, "y")
	for name, input := range map[string][]byte{
		"first offset not after the head": func() []byte {
			l := handList(a, b)
			copy(l[32*2:], word(0x80))
			return l
		}(),
		"equal offsets": func() []byte {
			l := handList(a, b)
			copy(l[32*3:], word(0x40))
			return l
		}(),
		"count larger than the bytes": func() []byte {
			l := handList(a)
			copy(l[32:], word(1000))
			return l
		}(),
		"second value shares the first": func() []byte {
			l := handList(a)
			copy(l[32*4+32:], word(0x80))
			return l
		}(),
		"value longer than its room": func() []byte {
			l := handList(a)
			copy(l[len(l)-64:], word(1<<20))
			return l
		}(),
	} {
		if _, err := Decode(input); !errors.Is(err, ErrMalformed) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

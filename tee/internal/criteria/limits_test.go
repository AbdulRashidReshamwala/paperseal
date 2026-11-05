package criteria

import (
	"bytes"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"testing"

	"paperseal/tee/internal/spec"
)

func topics(n int, name string) [][]byte {
	var out [][]byte
	for i := range n {
		out = append(out, topic(fmt.Sprintf("%s%d", name, i), 1))
	}
	return out
}

func TestByteCap(t *testing.T) {
	cap := spec.C.Limits.CriteriaBytes
	valid := handSample()
	atCap := append(bytes.Clone(valid), make([]byte, cap-len(valid))...)
	if _, err := Decode(atCap); errors.Is(err, ErrTooLarge) {
		t.Fatalf("exactly at the cap was refused for size: %v", err)
	}
	if _, err := Decode(append(atCap, 0)); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("one over: %v", err)
	}
}

func TestTopicAndNameLimits(t *testing.T) {
	lim := spec.C.Limits
	if _, err := Decode(hand(10, 3, topics(lim.Topics, "t")...)); err != nil {
		t.Fatalf("exactly %d topics: %v", lim.Topics, err)
	}
	if _, err := Decode(hand(10, 3, topics(lim.Topics+1, "t")...)); !errors.Is(err, ErrLimit) {
		t.Fatalf("one over topics: %v", err)
	}
	if _, err := Decode(hand(10, 3, topic(strings.Repeat("n", lim.TopicNameBytes), 1))); err != nil {
		t.Fatalf("name at the limit: %v", err)
	}
	if _, err := Decode(hand(10, 3, topic(strings.Repeat("n", lim.TopicNameBytes+1), 1))); !errors.Is(err, ErrLimit) {
		t.Fatalf("name one over: %v", err)
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

// Many topics share one large name. A plain decode would copy the name once per
// topic, so a small input would become a huge value.
func TestSharedOffsetAttackFailsCheaply(t *testing.T) {
	const n = 60
	big := topic(strings.Repeat("x", spec.C.Limits.CriteriaBytes-4096), 1)
	out := word(0x20)
	out = append(out, word(10)...)
	out = append(out, word(3)...)
	out = append(out, word(0x60)...)
	out = append(out, word(n)...)
	for range n {
		out = append(out, word(32*n)...)
	}
	out = append(out, big...)
	if len(out) > spec.C.Limits.CriteriaBytes {
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
	one := topic("a", 1)
	two := topic("b", 1)
	for name, input := range map[string][]byte{
		"first offset not after the head": func() []byte {
			b := hand(10, 3, one, two)
			copy(b[32*5:], word(0x80))
			return b
		}(),
		"equal offsets": func() []byte {
			b := hand(10, 3, one, two)
			copy(b[32*6:], word(0x40))
			return b
		}(),
		"decreasing offsets": func() []byte {
			b := hand(10, 3, one, two)
			copy(b[32*5:], word(0x40+uint64(len(one))))
			copy(b[32*6:], word(0x40))
			return b
		}(),
		"count larger than the bytes": func() []byte {
			b := hand(10, 3, one)
			copy(b[32*4:], word(1000))
			return b
		}(),
		"name longer than its room": func() []byte {
			b := hand(10, 3, one)
			copy(b[len(b)-64:], word(1<<20))
			return b
		}(),
	} {
		if _, err := Decode(input); !errors.Is(err, ErrMalformed) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

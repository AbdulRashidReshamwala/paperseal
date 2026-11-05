package abilayout

import (
	"encoding/binary"
	"errors"
	"testing"
)

func word(n uint64) []byte { return binary.BigEndian.AppendUint64(make([]byte, 24), n) }

func TestWordRejectsWide(t *testing.T) {
	b := word(1)
	b[0] = 1
	if _, err := Word(b, 0); !errors.Is(err, ErrLayout) {
		t.Fatal(err)
	}
	if _, err := Word(word(1<<63), 0); !errors.Is(err, ErrLayout) {
		t.Fatal(err)
	}
	if _, err := Word(word(1), 1); !errors.Is(err, ErrLayout) {
		t.Fatal(err)
	}
}

func TestBytes(t *testing.T) {
	b := append(word(3), make([]byte, 32)...)
	if end, err := Bytes(b, 0, len(b)); err != nil || end != 64 {
		t.Fatalf("end %d, %v", end, err)
	}
	if _, err := Bytes(b, 0, 63); !errors.Is(err, ErrLayout) {
		t.Fatalf("padding past the limit: %v", err)
	}
}

func TestEmptyArray(t *testing.T) {
	n, end, err := Array(word(0), 0, 32, nil)
	if err != nil || n != 0 || end != 32 {
		t.Fatalf("%d %d %v", n, end, err)
	}
}

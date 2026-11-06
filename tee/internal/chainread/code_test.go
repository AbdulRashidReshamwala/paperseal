package chainread

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"paperseal/tee/internal/spec"
)

type liveRegistry struct {
	Address string `json:"address"`
	Board   string `json:"board"`
	Code    string `json:"code"`
}

// liveCode is the deployed ExamRegistry, read from Sepolia with `cast code`.
func liveCode(t *testing.T) liveRegistry {
	t.Helper()
	raw, err := os.ReadFile("../../../spec/fixtures/registry-code.json")
	if err != nil {
		t.Fatal(err)
	}
	var l liveRegistry
	if err := json.Unmarshal(raw, &l); err != nil {
		t.Fatal(err)
	}
	return l
}

func liveBytes(t *testing.T) []byte {
	t.Helper()
	b, err := hex.DecodeString(strings.TrimPrefix(liveCode(t).Code, "0x"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// The pin must match the live contract, whose metadata differs from a new build.
func TestBoardFromCodeMatchesTheLiveContract(t *testing.T) {
	board, err := BoardFromCode(liveBytes(t))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := "0x"+hex.EncodeToString(board[:]), strings.ToLower(liveCode(t).Board); got != want {
		t.Fatalf("board %s, want %s", got, want)
	}
}

func TestBoardFromCodeIgnoresOnlyTheMetadata(t *testing.T) {
	code := liveBytes(t)
	metadata := int(code[len(code)-2])<<8 + int(code[len(code)-1]) + 2
	first := len(code) - metadata

	changed := append([]byte(nil), code...)
	changed[first] ^= 0xff
	if _, err := BoardFromCode(changed); err != nil {
		t.Fatalf("a changed metadata byte: %v", err)
	}
	// One executable byte, outside the board words.
	changed = append([]byte(nil), code...)
	changed[0] ^= 0xff
	if _, err := BoardFromCode(changed); !errors.Is(err, ErrWrongRegistry) {
		t.Fatalf("a changed code byte: %v", err)
	}
	if _, err := BoardFromCode(append(append([]byte(nil), code[:first]...), 0x00, 0x00, 0x00)); !errors.Is(err, ErrWrongRegistry) {
		t.Fatalf("a longer body: %v", err)
	}
}

func TestBoardFromCodeRefusesBadBoardWords(t *testing.T) {
	offsets := spec.R.BoardOffsets
	cases := map[string]func(code []byte){
		"words differ": func(code []byte) { code[offsets[0]+31] ^= 1 },
		"high bytes dirty": func(code []byte) {
			for _, o := range offsets {
				code[o] = 1
			}
		},
		"zero board": func(code []byte) {
			for _, o := range offsets {
				clear(code[o : o+32])
			}
		},
	}
	for name, change := range cases {
		code := liveBytes(t)
		change(code)
		if _, err := BoardFromCode(code); !errors.Is(err, ErrWrongRegistry) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestBoardFromCodeRefusesShortCode(t *testing.T) {
	for _, code := range [][]byte{{}, {0x00}, {0x00, 0x00}, {0xff, 0xff}, {0x60, 0x80, 0x00, 0x00}} {
		if _, err := BoardFromCode(code); !errors.Is(err, ErrWrongRegistry) {
			t.Errorf("%x: %v", code, err)
		}
	}
}

func TestOtherCodeIsTheWrongRegistry(t *testing.T) {
	c, r, _ := setup(t)
	c.code = "0x6080604052"
	ctx := context.Background()
	if _, err := r.Exam(ctx); !errors.Is(err, ErrWrongRegistry) {
		t.Fatalf("exam: %v", err)
	}
	if _, err := r.ApprovedList(ctx); !errors.Is(err, ErrWrongRegistry) {
		t.Fatalf("list: %v", err)
	}
	for _, method := range c.calls {
		if method == "eth_call" {
			t.Fatal("read from an address that failed the code check")
		}
	}
}

// None of these show the address is wrong, so none may end the exam.
func TestCodeReadFailuresAreRetried(t *testing.T) {
	cases := map[string]func(c *chain){
		"rpc error":   func(c *chain) { c.codeErr = true },
		"no code yet": func(c *chain) { c.code = "0x" },
		"not hex":     func(c *chain) { c.code = "0xzz" },
		"no prefix":   func(c *chain) { c.code = "6080" },
	}
	for name, breakIt := range cases {
		t.Run(name, func(t *testing.T) {
			c, r, _ := setup(t)
			good := c.code
			breakIt(c)
			ctx := context.Background()
			_, err := r.Exam(ctx)
			if err == nil || errors.Is(err, ErrWrongRegistry) || errors.Is(err, ErrWrongExam) || errors.Is(err, ErrNotPosted) {
				t.Fatalf("got %v", err)
			}
			c.code, c.codeErr = good, false
			if _, err := r.Exam(ctx); err != nil {
				t.Fatalf("after recovering: %v", err)
			}
		})
	}
}

func TestCodeIsCheckedOnce(t *testing.T) {
	c, r, _ := setup(t)
	ctx := context.Background()
	for range 3 {
		if _, err := r.Exam(ctx); err != nil {
			t.Fatal(err)
		}
	}
	reads := 0
	for _, method := range c.calls {
		if method == "eth_getCode" {
			reads++
		}
	}
	if reads != 1 {
		t.Fatalf("%d code reads, want 1", reads)
	}
}

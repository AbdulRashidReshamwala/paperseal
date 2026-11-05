package criteria

import (
	"bytes"
	"encoding/binary"
	"errors"
	"math"
	"reflect"
	"testing"

	"paperseal/tee/internal/spec"
)

func word(n uint64) []byte {
	return binary.BigEndian.AppendUint64(make([]byte, 24), n)
}

// tail is a length word, then the bytes with zero padding.
func tail(b []byte) []byte {
	out := append(word(uint64(len(b))), b...)
	if pad := len(b) % 32; pad != 0 {
		out = append(out, make([]byte, 32-pad)...)
	}
	return out
}

func topic(name string, questions uint64) []byte {
	return append(append(word(0x40), word(questions)...), tail([]byte(name))...)
}

// hand writes abi.encode(Criteria) by hand, independently of the library, so
// tests can hold values that Encode would refuse.
func hand(maxPercent, minMultiple uint64, topics ...[]byte) []byte {
	out := word(0x20)
	out = append(out, word(maxPercent)...)
	out = append(out, word(minMultiple)...)
	out = append(out, word(0x60)...)
	out = append(out, word(uint64(len(topics)))...)
	offset := uint64(32 * len(topics))
	for _, tp := range topics {
		out = append(out, word(offset)...)
		offset += uint64(len(tp))
	}
	for _, tp := range topics {
		out = append(out, tp...)
	}
	return out
}

func sample() Criteria {
	return Criteria{10, 3, []Topic{{"algebra", 12}, {"geometry", 8}}}
}

func handSample() []byte {
	return hand(10, 3, topic("algebra", 12), topic("geometry", 8))
}

func TestLayout(t *testing.T) {
	got, err := Encode(sample())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, handSample()) {
		t.Fatalf("got  %x\nwant %x", got, handSample())
	}
}

func TestRoundTrip(t *testing.T) {
	got, err := Decode(handSample())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, sample()) {
		t.Fatalf("got %+v", got)
	}
	if n, err := got.Selected(); err != nil || n != 20 {
		t.Fatalf("selected %d, %v", n, err)
	}
}

func TestBoundaryValuesPass(t *testing.T) {
	for name, input := range map[string][]byte{
		"lowest percent":  hand(1, 2, topic("a", 1)),
		"highest percent": hand(100, 2, topic("a", 1)),
		"UTF-8 name":      hand(10, 3, topic("gé", 1)),
		"long name":       hand(10, 3, topic(string(bytes.Repeat([]byte("a"), 33)), 1)),
	} {
		if _, err := Decode(input); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestRejectsRuleBreaks(t *testing.T) {
	cases := []struct {
		name  string
		input []byte
		want  error
	}{
		{"zero percent", hand(0, 3, topic("a", 1)), ErrMaxSetterPercent},
		{"percent above 100", hand(101, 3, topic("a", 1)), ErrMaxSetterPercent},
		{"zero multiple", hand(10, 0, topic("a", 1)), ErrMinBankMultiple},
		{"multiple of one", hand(10, 1, topic("a", 1)), ErrMinBankMultiple},
		{"no topics", hand(10, 3), ErrNoTopics},
		{"empty name", hand(10, 3, topic("", 1)), ErrTopicName},
		{"invalid UTF-8 name", hand(10, 3, topic("\xff", 1)), ErrTopicName},
		{"repeated name", hand(10, 3, topic("a", 1), topic("b", 1), topic("a", 2)), ErrRepeatedTopic},
		{"zero questions", hand(10, 3, topic("a", 1), topic("b", 0)), ErrTopicQuestions},
		{"sum over uint32", hand(10, 3, topic("a", math.MaxUint32), topic("b", 1)), ErrSelectedOverflow},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := Decode(c.input); !errors.Is(err, c.want) {
				t.Fatalf("got %v, want %v", err, c.want)
			}
		})
	}
}

func TestEncodeRejectsRuleBreaks(t *testing.T) {
	for name, c := range map[string]Criteria{
		"zero percent":   {0, 3, []Topic{{"a", 1}}},
		"low multiple":   {10, 1, []Topic{{"a", 1}}},
		"no topics":      {10, 3, nil},
		"empty name":     {10, 3, []Topic{{"", 1}}},
		"repeated name":  {10, 3, []Topic{{"a", 1}, {"a", 1}}},
		"zero questions": {10, 3, []Topic{{"a", 0}}},
	} {
		if _, err := Encode(c); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestRejectsEveryTruncation(t *testing.T) {
	b := handSample()
	for n := range len(b) {
		_, err := Decode(b[:n])
		if !errors.Is(err, ErrMalformed) && !errors.Is(err, ErrNonCanonical) {
			t.Fatalf("cut to %d bytes: %v", n, err)
		}
	}
}

// Numbers wider than the field can't come back as the same bytes.
func TestRejectsWideNumbers(t *testing.T) {
	for name, input := range map[string][]byte{
		"percent":   hand(1<<32+10, 3, topic("a", 1)),
		"multiple":  hand(10, 1<<32+3, topic("a", 1)),
		"questions": hand(10, 3, topic("a", 1<<32+1)),
	} {
		if _, err := Decode(input); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// Each of these decodes, but not from the one encoding.
func TestRejectsNonCanonicalEncodings(t *testing.T) {
	one := hand(10, 3, topic("a", 1))

	gap := append(word(0x40), make([]byte, 32)...) // Top offset skips a word.
	gap = append(gap, one[32:]...)

	topicsGap := bytes.Clone(one) // Topics offset skips a word.
	copy(topicsGap[32*3:], word(0x80))
	topicsGap = append(topicsGap[:32*4], append(make([]byte, 32), topicsGap[32*4:]...)...)

	dirty := bytes.Clone(one)
	dirty[len(dirty)-1] = 1 // After the one-byte name.

	shared := word(0x20) // Two topics share one tuple.
	shared = append(shared, word(10)...)
	shared = append(shared, word(3)...)
	shared = append(shared, word(0x60)...)
	shared = append(shared, word(2)...)
	shared = append(shared, word(0x40)...)
	shared = append(shared, word(0x40)...)
	shared = append(shared, topic("a", 1)...)

	// The layout check refuses gaps and shared values before any decoding.
	// Trailing bytes and dirty padding are what the canonical comparison catches.
	for name, want := range map[string]struct {
		input []byte
		err   error
	}{
		"trailing byte":       {append(bytes.Clone(one), 0), ErrNonCanonical},
		"trailing word":       {append(bytes.Clone(one), make([]byte, 32)...), ErrNonCanonical},
		"gap before criteria": {gap, ErrMalformed},
		"gap before topics":   {topicsGap, ErrMalformed},
		"dirty padding":       {dirty, ErrNonCanonical},
		"shared topic":        {shared, ErrMalformed},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Decode(want.input); !errors.Is(err, want.err) {
				t.Fatalf("got %v, want %v", err, want.err)
			}
		})
	}
}

func TestRejectsHugeLengths(t *testing.T) {
	b := handSample()
	for name, at := range map[string]int{
		"top offset": 0, "topics offset": 32 * 3, "topic count": 32 * 4, "first topic offset": 32 * 5,
	} {
		huge := bytes.Clone(b)
		for i := range 32 {
			huge[at+i] = 0xff
		}
		if _, err := Decode(huge); !errors.Is(err, ErrMalformed) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestRejectsNonCriteriaInput(t *testing.T) {
	for name, input := range map[string][]byte{"empty": nil, "one byte": {0}} {
		if _, err := Decode(input); !errors.Is(err, ErrMalformed) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// The bytes are hostile, so no input may panic the decoder.
func FuzzDecode(f *testing.F) {
	f.Add(handSample())
	f.Add(hand(100, 2, topic("a", 1)))
	f.Fuzz(func(t *testing.T, b []byte) {
		c, err := Decode(b)
		if err != nil {
			return
		}
		again, err := Encode(c)
		if err != nil || !bytes.Equal(again, b) {
			t.Fatalf("accepted criteria that don't round-trip: %v", err)
		}
	})
}

// The paper must fit: the questions' padded size plus 1024 bytes of JSON fit in
// padding.paperBytes, so a paper that passes Lock always fits.
func TestPaperSizeRule(t *testing.T) {
	fits := uint64((spec.C.Padding.PaperBytes - PaperJSONBytes) / spec.C.Padding.QuestionBytes)
	ok := hand(50, 2, topic("a", fits-1), topic("b", 1))
	if _, err := Decode(ok); err != nil {
		t.Fatalf("exactly at the limit: %v", err)
	}
	over := hand(50, 2, topic("a", fits-1), topic("b", 2))
	if _, err := Decode(over); !errors.Is(err, ErrPaperTooLarge) {
		t.Fatalf("Decode one over: %v", err)
	}
	if _, err := Encode(Criteria{MaxSetterPercent: 50, MinBankMultiple: 2, Topics: []Topic{{"a", uint32(fits + 1)}}}); !errors.Is(err, ErrPaperTooLarge) {
		t.Fatalf("Encode one over: %v", err)
	}
	if _, err := Encode(Criteria{MaxSetterPercent: 50, MinBankMultiple: 2, Topics: []Topic{{"a", uint32(fits)}}}); err != nil {
		t.Fatalf("Encode at the limit: %v", err)
	}
	// Sums that would wrap a smaller integer are refused too.
	huge := Criteria{MaxSetterPercent: 50, MinBankMultiple: 2, Topics: []Topic{{"a", math.MaxUint32}, {"b", math.MaxUint32}}}
	if err := huge.check(); err == nil {
		t.Fatal("overflowing sum accepted")
	}
}

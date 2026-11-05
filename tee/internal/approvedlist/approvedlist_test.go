package approvedlist

import (
	"bytes"
	"crypto/ecdh"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// key returns scalar times the P-256 base point.
func key(t *testing.T, scalar byte) []byte {
	t.Helper()
	s := make([]byte, 32)
	s[31] = scalar
	priv, err := ecdh.P256().NewPrivateKey(s)
	if err != nil {
		t.Fatal(err)
	}
	return priv.PublicKey().Bytes()
}

// commit is a well-formed setter owner: 0x and 64 lowercase hex digits.
func commit(name string) string {
	sum := sha256.Sum256([]byte(name))
	return "0x" + hex.EncodeToString(sum[:])
}

// fullList is an acceptable list: 3 neutrals, 7 centre holders, a setter and a
// centre without a share.
func fullList(t *testing.T) []Entry {
	t.Helper()
	var list []Entry
	add := func(role Role, name string) {
		n := byte(len(list))
		e := Entry{Role: role, PasskeyPublicKey: key(t, 2*n+1), DerivedPublicKey: key(t, 2*n+2), Owner: name}
		if role == RoleSetter {
			e.DerivedPublicKey = nil
		}
		list = append(list, e)
	}
	add(RoleSetter, commit("setter"))
	for i := range 3 {
		add(RoleNeutral, fmt.Sprintf("neutral-%d", i))
	}
	for i := range 7 {
		add(RoleCentreHolder, fmt.Sprintf("centre-%d", i))
	}
	add(RoleCentre, "centre without a share")
	return list
}

func encode(t *testing.T, entries []Entry) []byte {
	t.Helper()
	b, err := Encode(entries)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestRoundTrip(t *testing.T) {
	want := fullList(t)
	b := encode(t, want)
	got, err := Decode(b)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(want) {
		t.Fatalf("got %d entries", len(got))
	}
	for i := range want {
		if got[i].Role != want[i].Role || got[i].Owner != want[i].Owner ||
			!bytes.Equal(got[i].PasskeyPublicKey, want[i].PasskeyPublicKey) ||
			!bytes.Equal(got[i].DerivedPublicKey, want[i].DerivedPublicKey) {
			t.Errorf("entry %d: got %+v", i, got[i])
		}
	}
	if !bytes.Equal(encode(t, got), b) {
		t.Error("re-encoding changed the bytes")
	}
}

// Order is free, and the hash covers the bytes as posted.
func TestOrderIsFree(t *testing.T) {
	list := fullList(t)
	list[0], list[len(list)-1] = list[len(list)-1], list[0]
	if _, err := Decode(encode(t, list)); err != nil {
		t.Fatal(err)
	}
}

func word(n uint64) []byte {
	return binary.BigEndian.AppendUint64(make([]byte, 24), n)
}

func tail(b []byte) []byte {
	out := append(word(uint64(len(b))), b...)
	if pad := len(b) % 32; pad != 0 {
		out = append(out, make([]byte, 32-pad)...)
	}
	return out
}

// tuple writes one Entry by hand, independently of the library under test.
func tuple(role byte, passkey, derived []byte, owner string) []byte {
	a, b, c := tail(passkey), tail(derived), tail([]byte(owner))
	out := word(uint64(role))
	out = append(out, word(0x80)...)
	out = append(out, word(uint64(0x80+len(a)))...)
	out = append(out, word(uint64(0x80+len(a)+len(b)))...)
	return append(append(append(out, a...), b...), c...)
}

// handList writes abi.encode(Entry[]) by hand, so tests can hold entries that
// Encode would refuse.
func handList(tuples ...[]byte) []byte {
	out := append(word(0x20), word(uint64(len(tuples)))...)
	offset := uint64(32 * len(tuples))
	for _, tp := range tuples {
		out = append(out, word(offset)...)
		offset += uint64(len(tp))
	}
	for _, tp := range tuples {
		out = append(out, tp...)
	}
	return out
}

func raw(role byte, passkey, derived []byte, owner string) []byte {
	return handList(tuple(role, passkey, derived, owner))
}

// The library's bytes must match the ABI layout written out by hand.
func TestLayout(t *testing.T) {
	a, b, c := key(t, 1), key(t, 2), key(t, 3)
	got := encode(t, []Entry{
		{RoleSetter, a, nil, commit("s")},
		{RoleCentre, b, c, "cé"},
	})
	want := handList(tuple(1, a, nil, commit("s")), tuple(4, b, c, "cé"))
	if !bytes.Equal(got, want) {
		t.Fatalf("got  %x\nwant %x", got, want)
	}
}

// Every prefix of a valid list is refused, which covers a cut in each field.
func TestRejectsEveryTruncation(t *testing.T) {
	b := encode(t, fullList(t))
	for n := range len(b) {
		_, err := Decode(b[:n])
		if !errors.Is(err, ErrMalformed) && !errors.Is(err, ErrNonCanonical) {
			t.Fatalf("cut to %d bytes: %v", n, err)
		}
	}
}

func TestRejectsTrailingBytes(t *testing.T) {
	b := encode(t, fullList(t))
	for name, extra := range map[string][]byte{
		"one byte": {0}, "one word": make([]byte, 32), "non-zero": {1},
	} {
		if _, err := Decode(append(bytes.Clone(b), extra...)); !errors.Is(err, ErrNonCanonical) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// A count or length that claims more than the input must fail, without
// allocating for the claim or wrapping around.
func TestRejectsHugeLengths(t *testing.T) {
	b := encode(t, fullList(t))
	for name, at := range map[string]int{
		"top offset": 0, "count": 32, "first offset": 64, "first passkey offset": 32*(2+12) + 32,
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

// Each of these decodes to a list, but not from its one encoding.
func TestRejectsNonCanonicalEncodings(t *testing.T) {
	a, b := key(t, 1), key(t, 2)
	one := raw(1, a, nil, "x")

	gap := append(word(0x40), make([]byte, 32)...) // Top offset skips a word.
	gap = append(gap, one[32:]...)

	dirtyPadding := bytes.Clone(one)
	dirtyPadding[len(dirtyPadding)-1] = 1 // After the one-byte owner.

	shared := append(word(0x20), word(2)...) // Two entries share one tuple.
	shared = append(shared, word(0x40)...)
	shared = append(shared, word(0x40)...)
	shared = append(shared, tuple(4, a, b, "x")...)

	reordered := handList(tuple(1, a, nil, "x")) // Tuple tail fields swapped.
	head := 32 * 3
	copy(reordered[head+32:], word(0x80+32+96))
	copy(reordered[head+64:], word(0x80))

	// The layout check refuses these before any decoding. Dirty padding is the
	// one the canonical comparison has to catch.
	for name, want := range map[string]struct {
		input []byte
		err   error
	}{
		"gap before the list": {gap, ErrMalformed},
		"dirty padding":       {dirtyPadding, ErrNonCanonical},
		"shared tuple":        {shared, ErrMalformed},
		"swapped offsets":     {reordered, ErrMalformed},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Decode(want.input); !errors.Is(err, want.err) {
				t.Fatalf("got %v, want %v", err, want.err)
			}
		})
	}
}

// A role word above 255 can't become a uint8 and be written back the same.
func TestRejectsWideRole(t *testing.T) {
	input := raw(1, key(t, 1), nil, "x")
	input[32*3+30] = 1 // Role word becomes 0x0101.
	if _, err := Decode(input); err == nil {
		t.Fatal("accepted")
	}
}

func TestRejectsNonListInput(t *testing.T) {
	for name, input := range map[string][]byte{
		"empty": nil, "one byte": {0},
	} {
		if _, err := Decode(input); !errors.Is(err, ErrMalformed) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// A zero offset reads the offset word as the count, and the layout check refuses it.
	if _, err := Decode(make([]byte, 32)); !errors.Is(err, ErrMalformed) {
		t.Errorf("one word: %v", err)
	}
}

func TestRejectsBadEntries(t *testing.T) {
	a, b := key(t, 1), key(t, 2)
	offCurve := bytes.Clone(b)
	offCurve[64] ^= 1
	compressed := append([]byte{0x02}, b[1:33]...)
	cases := []struct {
		name  string
		input []byte
		want  error
	}{
		{"role zero", raw(0, a, nil, "x"), ErrUnknownRole},
		{"role five", raw(5, a, b, "x"), ErrUnknownRole},
		{"role 255", raw(255, a, b, "x"), ErrUnknownRole},
		{"off-curve passkey", raw(1, offCurve, nil, "x"), ErrPasskey},
		{"short passkey", raw(1, a[:64], nil, "x"), ErrPasskey},
		{"long passkey", raw(1, append(bytes.Clone(a), 0), nil, "x"), ErrPasskey},
		{"empty passkey", raw(1, nil, nil, "x"), ErrPasskey},
		{"setter with a key", raw(1, a, b, "x"), ErrDerivedKey},
		{"setter with one byte", raw(1, a, []byte{4}, "x"), ErrDerivedKey},
		{"neutral without a key", raw(2, a, nil, "x"), ErrDerivedKey},
		{"holder centre without a key", raw(3, a, nil, "x"), ErrDerivedKey},
		{"centre without a key", raw(4, a, nil, "x"), ErrDerivedKey},
		{"short key", raw(2, a, b[:64], "x"), ErrDerivedKey},
		{"long key", raw(3, a, append(bytes.Clone(b), 0), "x"), ErrDerivedKey},
		{"compressed key", raw(4, a, compressed, "x"), ErrDerivedKey},
		{"off-curve key", raw(4, a, offCurve, "x"), ErrDerivedKey},
		{"empty owner", raw(1, a, nil, ""), ErrOwner},
		{"invalid UTF-8 owner", raw(1, a, nil, "\xff"), ErrOwner},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := Decode(c.input); !errors.Is(err, c.want) {
				t.Fatalf("got %v, want %v", err, c.want)
			}
		})
	}
}

func TestSetterOwnerIsACommitment(t *testing.T) {
	a := key(t, 1)
	good := commit("x")
	upper := "0x" + strings.ToUpper(good[2:])
	for name, owner := range map[string]string{
		"a name":            "setter-01",
		"no prefix":         good[2:],
		"uppercase hex":     upper,
		"uppercase prefix":  "0X" + good[2:],
		"too short":         good[:len(good)-1],
		"too long":          good + "0",
		"non-hex digit":     good[:2] + "g" + good[3:],
		"surrounding space": " " + good,
		"trailing newline":  good + "\n",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Decode(raw(1, a, nil, owner)); !errors.Is(err, ErrSetterOwner) {
				t.Fatalf("got %v, want ErrSetterOwner", err)
			}
			if _, err := Encode([]Entry{{RoleSetter, a, nil, owner}}); !errors.Is(err, ErrSetterOwner) {
				t.Fatalf("Encode: got %v, want ErrSetterOwner", err)
			}
		})
	}
	list := append(fullList(t)[1:], Entry{RoleSetter, a, nil, good})
	if _, err := Decode(encode(t, list)); err != nil {
		t.Fatalf("well-formed commitment: %v", err)
	}
}

func TestOtherRolesOwnerIsAnyNonBlankText(t *testing.T) {
	a, b := key(t, 1), key(t, 2)
	for _, role := range []byte{2, 3, 4} {
		for _, owner := range []string{"", " ", "\t\n ", "\u00a0"} {
			if _, err := Decode(raw(role, a, b, owner)); !errors.Is(err, ErrOwner) {
				t.Errorf("role %d, owner %q: got %v, want ErrOwner", role, owner, err)
			}
		}
		// Only a setter's owner has a format. Any other text is fine.
		for _, owner := range []string{"centre-01", "x", "0x12", "cé"} {
			if _, err := Decode(raw(role, a, b, owner)); errors.Is(err, ErrOwner) || errors.Is(err, ErrSetterOwner) {
				t.Errorf("role %d, owner %q: got %v", role, owner, err)
			}
		}
	}
	for _, owner := range []string{"", " ", "\t"} {
		if _, err := Decode(raw(1, a, nil, owner)); !errors.Is(err, ErrOwner) {
			t.Errorf("setter, owner %q: got %v, want ErrOwner", owner, err)
		}
	}
}

func TestEncodeRejectsBadEntries(t *testing.T) {
	a := key(t, 1)
	for name, e := range map[string]Entry{
		"unknown role":    {Role(9), a, nil, "x"},
		"empty owner":     {RoleSetter, a, nil, ""},
		"setter with key": {RoleSetter, a, a, "x"},
		"holder no key":   {RoleNeutral, a, nil, "x"},
		"no passkey":      {RoleSetter, nil, nil, "x"},
	} {
		if _, err := Encode([]Entry{e}); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestRejectsRepeatedPasskey(t *testing.T) {
	list := fullList(t)
	list[len(list)-1].PasskeyPublicKey = list[0].PasskeyPublicKey
	if _, err := Decode(encode(t, list)); !errors.Is(err, ErrRepeatedPasskey) {
		t.Fatalf("got %v", err)
	}
}

func TestRejectsRepeatedDerivedKey(t *testing.T) {
	list := fullList(t)
	list[len(list)-1].DerivedPublicKey = list[1].DerivedPublicKey
	if _, err := Decode(encode(t, list)); !errors.Is(err, ErrRepeatedDerivedKey) {
		t.Fatalf("got %v", err)
	}
}

// Setters have no derived key, so their empty keys are not repeats.
func TestManySettersAreNotRepeatedDerivedKeys(t *testing.T) {
	list := append(fullList(t), Entry{RoleSetter, key(t, 205), nil, commit("second setter")})
	if _, err := Decode(encode(t, list)); err != nil {
		t.Fatal(err)
	}
}

func TestRejectsWrongHolderCounts(t *testing.T) {
	index := func(list []Entry, role Role) int {
		for i, e := range list {
			if e.Role == role {
				return i
			}
		}
		t.Fatalf("no role %d", role)
		return 0
	}
	cases := []struct {
		name string
		edit func([]Entry) []Entry
	}{
		{"empty", func([]Entry) []Entry { return nil }},
		{"one neutral fewer", func(l []Entry) []Entry {
			i := index(l, RoleNeutral)
			return append(l[:i], l[i+1:]...)
		}},
		{"one holder centre fewer", func(l []Entry) []Entry {
			i := index(l, RoleCentreHolder)
			return append(l[:i], l[i+1:]...)
		}},
		// Ten holders in total, split wrongly, must still fail.
		{"a neutral swapped for a centre", func(l []Entry) []Entry {
			l[index(l, RoleNeutral)].Role = RoleCentreHolder
			return l
		}},
		{"a centre swapped for a neutral", func(l []Entry) []Entry {
			l[index(l, RoleCentreHolder)].Role = RoleNeutral
			return l
		}},
		{"one extra neutral", func(l []Entry) []Entry {
			l[index(l, RoleCentre)].Role = RoleNeutral
			return l
		}},
		{"one extra holder centre", func(l []Entry) []Entry {
			l[index(l, RoleCentre)].Role = RoleCentreHolder
			return l
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			b := encode(t, c.edit(fullList(t)))
			if _, err := Decode(b); !errors.Is(err, ErrHolderCount) {
				t.Fatalf("got %v", err)
			}
		})
	}
}

// A list can have any number of setters and of centres without a share.
func TestOtherRolesAreNotCounted(t *testing.T) {
	list := fullList(t)
	list = append(list, Entry{RoleSetter, key(t, 201), nil, commit("another setter")})
	list = append(list, Entry{RoleCentre, key(t, 203), key(t, 204), "another centre"})
	if _, err := Decode(encode(t, list)); err != nil {
		t.Fatal(err)
	}
}

type registered map[string]bool

func regKey(passkey, derived []byte, owner string) string {
	return string(passkey) + "|" + string(derived) + "|" + owner
}

func (r registered) Verified(passkey, derived []byte, owner string) bool {
	return r[regKey(passkey, derived, owner)]
}

func TestCheckRegistered(t *testing.T) {
	list := fullList(t)
	reg := registered{}
	for _, e := range list {
		reg[regKey(e.PasskeyPublicKey, e.DerivedPublicKey, e.Owner)] = true
	}
	if err := CheckRegistered(list, reg); err != nil {
		t.Fatal(err)
	}
	// Each field of an entry must match its registration.
	edits := map[string]func(e *Entry){
		"owner":   func(e *Entry) { e.Owner = "someone else" },
		"passkey": func(e *Entry) { e.PasskeyPublicKey = key(t, 250) },
		"derived": func(e *Entry) { e.DerivedPublicKey = key(t, 251) },
	}
	for name, edit := range edits {
		l := fullList(t)
		edit(&l[1])
		if err := CheckRegistered(l, reg); !errors.Is(err, ErrNotRegistered) {
			t.Errorf("%s: got %v", name, err)
		}
	}
	// A setter listed with a derived key was registered without one.
	l := fullList(t)
	for i := range l {
		if l[i].Role == RoleSetter {
			l[i].DerivedPublicKey = key(t, 252)
		}
	}
	if err := CheckRegistered(l, reg); !errors.Is(err, ErrNotRegistered) {
		t.Errorf("setter with a derived key: got %v", err)
	}
	if err := CheckRegistered(list, registered{}); !errors.Is(err, ErrNotRegistered) {
		t.Errorf("nothing registered: got %v", err)
	}
}

func TestErrorsNameTheEntry(t *testing.T) {
	if _, err := Decode(raw(9, key(t, 1), nil, "x")); err == nil || !strings.Contains(err.Error(), "entry 0") {
		t.Fatalf("got %v", err)
	}
}

// The bytes are hostile, so no input may panic the decoder.
func FuzzDecode(f *testing.F) {
	k := make([]byte, 32)
	k[31] = 1
	priv, err := ecdh.P256().NewPrivateKey(k)
	if err != nil {
		f.Fatal(err)
	}
	pub := priv.PublicKey().Bytes()
	f.Add(raw(1, pub, nil, "x"))
	f.Add(raw(4, pub, pub, "owner"))
	f.Add(handList(tuple(2, pub, pub, "a"), tuple(3, pub, pub, "b")))
	f.Fuzz(func(t *testing.T, b []byte) {
		entries, err := Decode(b)
		if err != nil {
			return
		}
		again, err := Encode(entries)
		if err != nil || !bytes.Equal(again, b) {
			t.Fatalf("accepted a list that doesn't round-trip: %v", err)
		}
	})
}

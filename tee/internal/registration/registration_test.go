package registration

import (
	"errors"
	"testing"
)

func TestAddVerifiedAndDuplicates(t *testing.T) {
	var s Store
	r := Record{Owner: "centre-1", PasskeyPublicKey: []byte{1}, DerivedPublicKey: []byte{2}}
	if err := s.Add(r); err != nil {
		t.Fatal(err)
	}
	if !s.Verified([]byte{1}, []byte{2}, "centre-1") {
		t.Fatal("registered entry not verified")
	}
	for name, probe := range map[string]func() bool{
		"owner":   func() bool { return s.Verified([]byte{1}, []byte{2}, "x") },
		"passkey": func() bool { return s.Verified([]byte{9}, []byte{2}, "centre-1") },
		"derived": func() bool { return s.Verified([]byte{1}, nil, "centre-1") },
	} {
		if probe() {
			t.Errorf("%s mismatch verified", name)
		}
	}
	if err := s.Add(Record{Owner: "z", PasskeyPublicKey: []byte{1}}); !errors.Is(err, ErrDuplicate) {
		t.Errorf("repeated passkey: %v", err)
	}
	if err := s.Add(Record{Owner: "z", PasskeyPublicKey: []byte{5}, DerivedPublicKey: []byte{2}}); !errors.Is(err, ErrDuplicate) {
		t.Errorf("repeated derived key: %v", err)
	}
	// Setters have no derived key and don't clash on that.
	if err := s.Add(Record{Owner: "s1", PasskeyPublicKey: []byte{6}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Add(Record{Owner: "s2", PasskeyPublicKey: []byte{7}}); err != nil {
		t.Fatal(err)
	}
	s.Close()
	if err := s.Add(Record{Owner: "late", PasskeyPublicKey: []byte{8}}); !errors.Is(err, ErrClosed) {
		t.Errorf("after close: %v", err)
	}
	l := s.List()
	if len(l) != 3 || l[0].Owner != "centre-1" || l[2].Owner != "s2" {
		t.Errorf("list %+v", l)
	}
	l[0].PasskeyPublicKey[0] = 99
	if s.List()[0].PasskeyPublicKey[0] != 1 {
		t.Error("List returned the store's own bytes")
	}
	if s.Count() != 3 {
		t.Errorf("count %d", s.Count())
	}
}

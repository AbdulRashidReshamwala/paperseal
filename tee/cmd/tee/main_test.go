package main

import (
	"crypto/x509"
	"testing"

	"paperseal/tee/internal/storage"
)

func TestNewStore(t *testing.T) {
	roots := x509.NewCertPool()
	if _, err := newStore("", "", roots); err == nil {
		t.Error("no storage configured")
	}
	if _, err := newStore("b", "/tmp/x", roots); err == nil {
		t.Error("both configured")
	}
	s, err := newStore("bucket", "", roots)
	if err != nil {
		t.Fatal(err)
	}
	if b, ok := s.(*storage.Bucket); !ok || b.Name != "bucket" {
		t.Errorf("got %T", s)
	}
	s, err = newStore("", t.TempDir(), roots)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := s.(storage.Dir); !ok {
		t.Errorf("got %T", s)
	}
}

func TestRunRefusesBadSettings(t *testing.T) {
	if err := run(nil); err == nil {
		t.Fatal("started without settings")
	}
}

package timelock

import (
	"context"
	"errors"
	"strings"
	"testing"

	"paperseal/tee/internal/spec"
)

func TestQuickNetMatchesConstants(t *testing.T) {
	c, err := QuickNet()
	if err != nil {
		t.Fatal(err)
	}
	if c.Hash != spec.C.Drand.ChainHash || c.Genesis != spec.C.Drand.GenesisTime {
		t.Fatalf("chain %+v", c)
	}
	if c.PublicKey.Equal(c.PublicKey.Null()) {
		t.Fatal("null public key")
	}
}

func TestSealIsArmouredAndRejectsBadInput(t *testing.T) {
	c, err := QuickNet()
	if err != nil {
		t.Fatal(err)
	}
	out, err := NewSealer(c).Seal(context.Background(), 123, []byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(out), "-----BEGIN AGE ENCRYPTED FILE-----") {
		t.Fatalf("not armoured: %q", out[:30])
	}
	if strings.Contains(string(out), "secret") {
		t.Fatal("plaintext in output")
	}
	if _, err := NewSealer(c).Seal(context.Background(), 0, []byte("x")); err == nil {
		t.Error("sealed to round 0")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := NewSealer(c).Seal(ctx, 5, []byte("x")); !errors.Is(err, context.Canceled) {
		t.Errorf("want context.Canceled, got %v", err)
	}
}

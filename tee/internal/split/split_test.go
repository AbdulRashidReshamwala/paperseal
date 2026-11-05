package split

import (
	"bytes"
	"crypto/rand"
	"errors"
	"testing"
	"testing/iotest"

	"github.com/hashicorp/vault/shamir"
)

func randomKey(t *testing.T) []byte {
	t.Helper()
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		t.Fatal(err)
	}
	return k
}

// subsets calls fn with every way of choosing size items from shares.
func subsets(shares [][]byte, size int, fn func([][]byte)) {
	var walk func(start int, chosen [][]byte)
	walk = func(start int, chosen [][]byte) {
		if len(chosen) == size {
			fn(chosen)
			return
		}
		for i := start; i < len(shares); i++ {
			walk(i+1, append(chosen[:len(chosen):len(chosen)], shares[i]))
		}
	}
	walk(0, nil)
}

func TestXORRoundTrip(t *testing.T) {
	k := randomKey(t)
	kPub, kPriv, err := SplitKey(k)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(kPub, k) || bytes.Equal(kPriv, k) {
		t.Fatal("a half equals K")
	}
	got, err := CombineKey(kPub, kPriv)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, k) {
		t.Fatal("halves did not rebuild K")
	}
}

func TestXORKnownBytes(t *testing.T) {
	k := bytes.Repeat([]byte{0xf0}, 32)
	mask := bytes.Repeat([]byte{0x3c}, 32)
	kPub, kPriv, err := splitKeyFrom(bytes.NewReader(mask), k)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(kPriv, mask) || !bytes.Equal(kPub, bytes.Repeat([]byte{0xcc}, 32)) {
		t.Fatalf("kPub=%x kPriv=%x", kPub, kPriv)
	}
}

func TestXORRejectsBadInput(t *testing.T) {
	if _, _, err := SplitKey(make([]byte, 31)); err == nil {
		t.Error("31-byte K accepted")
	}
	if _, err := CombineKey(make([]byte, 32), make([]byte, 33)); err == nil {
		t.Error("mismatched halves accepted")
	}
	if _, _, err := splitKeyFrom(iotest.ErrReader(errors.New("no entropy")), make([]byte, 32)); err == nil {
		t.Error("failed randomness accepted")
	}
}

func TestAnyEightSharesRebuild(t *testing.T) {
	secret := randomKey(t)
	shares, err := SplitShares(secret)
	if err != nil {
		t.Fatal(err)
	}
	if len(shares) != 10 {
		t.Fatalf("got %d shares, want 10", len(shares))
	}
	count := 0
	subsets(shares, 8, func(chosen [][]byte) {
		count++
		got, err := CombineShares(chosen)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, secret) {
			t.Fatal("8 shares did not rebuild K_priv")
		}
	})
	if count != 45 {
		t.Fatalf("tried %d subsets, want 45", count)
	}
}

func TestMoreThanEightSharesRebuild(t *testing.T) {
	secret := randomKey(t)
	shares, err := SplitShares(secret)
	if err != nil {
		t.Fatal(err)
	}
	for _, size := range []int{9, 10} {
		subsets(shares, size, func(chosen [][]byte) {
			got, err := CombineShares(chosen)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, secret) {
				t.Fatalf("%d shares did not rebuild K_priv", size)
			}
		})
	}
}

func TestSevenSharesDoNotRebuild(t *testing.T) {
	secret := randomKey(t)
	shares, err := SplitShares(secret)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	subsets(shares, 7, func(chosen [][]byte) {
		count++
		if _, err := CombineShares(chosen); !errors.Is(err, ErrTooFewShares) {
			t.Fatalf("CombineShares: %v", err)
		}
		// The library itself has no threshold check, so the bytes it returns
		// must also be wrong.
		got, err := shamir.Combine(chosen)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Equal(got, secret) {
			t.Fatal("7 shares rebuilt K_priv")
		}
	})
	if count != 120 {
		t.Fatalf("tried %d subsets, want 120", count)
	}
}

func TestTamperedShareGivesWrongKey(t *testing.T) {
	secret := randomKey(t)
	shares, err := SplitShares(secret)
	if err != nil {
		t.Fatal(err)
	}
	shares[0][0] ^= 1
	got, err := CombineShares(shares[:8])
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(got, secret) {
		t.Fatal("a tampered share still rebuilt K_priv")
	}
}

func TestDuplicateShareRejected(t *testing.T) {
	shares, err := SplitShares(randomKey(t))
	if err != nil {
		t.Fatal(err)
	}
	dup := append([][]byte{shares[0]}, shares[:7]...)
	if _, err := CombineShares(dup); err == nil {
		t.Fatal("duplicate share accepted")
	}
}

func TestSplitSharesRejectsBadLength(t *testing.T) {
	if _, err := SplitShares(make([]byte, 16)); err == nil {
		t.Fatal("16-byte secret accepted")
	}
}

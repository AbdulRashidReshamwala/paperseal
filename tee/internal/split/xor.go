// Package split splits K into K_pub and K_priv, and K_priv into Shamir shares.
package split

import (
	"crypto/rand"
	"crypto/subtle"
	"fmt"
	"io"

	"paperseal/tee/internal/spec"
)

// SplitKey returns K_pub and K_priv, where K = K_pub XOR K_priv. K_priv is
// fresh randomness, so either half alone says nothing about K.
func SplitKey(k []byte) (kPub, kPriv []byte, err error) {
	return splitKeyFrom(rand.Reader, k)
}

func splitKeyFrom(r io.Reader, k []byte) (kPub, kPriv []byte, err error) {
	if err := checkKeyLen(k); err != nil {
		return nil, nil, err
	}
	kPriv = make([]byte, len(k))
	if _, err := io.ReadFull(r, kPriv); err != nil {
		return nil, nil, fmt.Errorf("split: read randomness: %w", err)
	}
	kPub = make([]byte, len(k))
	subtle.XORBytes(kPub, k, kPriv)
	return kPub, kPriv, nil
}

// CombineKey returns K from its two halves.
func CombineKey(kPub, kPriv []byte) ([]byte, error) {
	if err := checkKeyLen(kPub); err != nil {
		return nil, err
	}
	if err := checkKeyLen(kPriv); err != nil {
		return nil, err
	}
	k := make([]byte, len(kPub))
	subtle.XORBytes(k, kPub, kPriv)
	return k, nil
}

func checkKeyLen(k []byte) error {
	if len(k) != spec.C.Crypto.KeyBytes {
		return fmt.Errorf("split: key is %d bytes, want %d", len(k), spec.C.Crypto.KeyBytes)
	}
	return nil
}

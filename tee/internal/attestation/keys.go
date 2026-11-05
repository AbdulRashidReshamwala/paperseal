package attestation

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"

	"paperseal/tee/internal/encryption"
	"paperseal/tee/internal/hashing"
)

// Keys are the two P-256 keys an instance makes in memory at start and never
// stores: a signing key, which is instancePublicKey, and a separate HPKE key.
// The signing key signs the encryption key through the instanceKey message.
type Keys struct {
	examID         [32]byte
	signing        *ecdsa.PrivateKey
	signingPublic  []byte
	enc            *encryption.PrivateKey
	instanceKeySig [64]byte
}

var _ Signer = (*Keys)(nil)

// NewKeys generates both keys and signs the encryption key.
func NewKeys(examID [32]byte) (*Keys, error) {
	signing, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("attestation: signing key: %w", err)
	}
	ecdhKey, err := signing.PublicKey.ECDH()
	if err != nil {
		return nil, err
	}
	enc, err := encryption.GenerateKey()
	if err != nil {
		return nil, err
	}
	k := &Keys{examID: examID, signing: signing, signingPublic: ecdhKey.Bytes(), enc: enc}
	m, err := hashing.InstanceKey(examID, enc.PublicKey())
	if err != nil {
		return nil, err
	}
	if k.instanceKeySig, err = k.Sign(m); err != nil {
		return nil, err
	}
	return k, nil
}

// PublicKey is instancePublicKey, 65 bytes uncompressed.
func (k *Keys) PublicKey() []byte { return append([]byte(nil), k.signingPublic...) }

// EncryptionPublicKey is encryptionPublicKey, 65 bytes uncompressed.
func (k *Keys) EncryptionPublicKey() []byte { return k.enc.PublicKey() }

// InstanceKeySignature is the signature over the instanceKey message.
func (k *Keys) InstanceKeySignature() [64]byte { return k.instanceKeySig }

// Open decrypts an HPKE message sent to the encryption key.
func (k *Keys) Open(p encryption.Purpose, framed []byte) ([]byte, error) {
	return k.enc.Open(p, k.examID, framed)
}

// Sign signs the message hash as 64-byte r || s with low s.
func (k *Keys) Sign(m hashing.Message) ([64]byte, error) {
	digest := m.Sum()
	r, s, err := ecdsa.Sign(rand.Reader, k.signing, digest[:])
	if err != nil {
		return [64]byte{}, fmt.Errorf("attestation: sign: %w", err)
	}
	// ECDSA accepts s and n-s alike. Fixing the low one gives one encoding.
	n := elliptic.P256().Params().N
	if s.Cmp(new(big.Int).Rsh(n, 1)) > 0 {
		s.Sub(n, s)
	}
	var sig [64]byte
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return sig, nil
}

// ErrBadSignature is returned for a signature that doesn't verify or isn't in
// the low-s form.
var ErrBadSignature = errors.New("attestation: bad signature")

// Verify checks a 64-byte r || s signature over the message hash. It rejects a
// high s, so a signature has one encoding.
func Verify(publicKey []byte, m hashing.Message, sig [64]byte) error {
	if err := hashing.CheckPublicKey(publicKey); err != nil {
		return fmt.Errorf("%w: %v", ErrBadSignature, err)
	}
	// CheckPublicKey has confirmed the point is on the curve.
	x := new(big.Int).SetBytes(publicKey[1:33])
	y := new(big.Int).SetBytes(publicKey[33:])
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:])
	if s.Cmp(new(big.Int).Rsh(elliptic.P256().Params().N, 1)) > 0 {
		return fmt.Errorf("%w: s is not low", ErrBadSignature)
	}
	digest := m.Sum()
	if !ecdsa.Verify(&ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, digest[:], r, s) {
		return ErrBadSignature
	}
	return nil
}

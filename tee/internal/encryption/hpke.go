// Package encryption is the encryption in spec/api.md "Encryption": HPKE for
// messages sent to a P-256 key, AES-256-GCM for the paper, and the padding both
// carry. HPKE is circl's implementation of RFC 9180 and AES-GCM is the standard
// library's. Nothing here is a primitive.
package encryption

import (
	"crypto/rand"
	"errors"
	"fmt"
	"io"

	"github.com/cloudflare/circl/hpke"
	"github.com/cloudflare/circl/kem"

	"paperseal/tee/internal/hashing"
	"paperseal/tee/internal/spec"
)

// Purpose picks the HPKE `info` string, so a message for one purpose can't be
// opened as another.
type Purpose int

const (
	PurposeQuestion Purpose = iota + 1
	PurposeShare
	PurposeRelease
	PurposeKeyPriv
)

func (p Purpose) info() ([]byte, error) {
	i := spec.C.Crypto.HPKE.Info
	switch p {
	case PurposeQuestion:
		return []byte(i.Question), nil
	case PurposeShare:
		return []byte(i.Share), nil
	case PurposeRelease:
		return []byte(i.Release), nil
	case PurposeKeyPriv:
		return []byte(i.KeyPriv), nil
	}
	return nil, fmt.Errorf("encryption: unknown purpose %d", p)
}

// The suite is DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM, which is
// what spec.C.Crypto.HPKE names. TestSuiteMatchesConstants guards the pairing.
var (
	kemID = hpke.KEM_P256_HKDF_SHA256
	suite = hpke.NewSuite(hpke.KEM_P256_HKDF_SHA256, hpke.KDF_HKDF_SHA256, hpke.AEAD_AES256GCM)
)

// ErrOpen is returned when a message doesn't open. It says nothing about why,
// so a sender learns nothing from the difference.
var ErrOpen = errors.New("encryption: message did not open")

// PrivateKey is an HPKE private key on P-256.
type PrivateKey struct {
	k   kem.PrivateKey
	pub []byte
}

// GenerateKey returns a fresh random key. The instance key is made this way.
func GenerateKey() (*PrivateKey, error) {
	_, sk, err := kemID.Scheme().GenerateKeyPair()
	if err != nil {
		return nil, fmt.Errorf("encryption: generate key: %w", err)
	}
	return wrap(sk)
}

// DeriveKey is RFC 9180 DeriveKeyPair over a 32-byte input, which is how a
// holder's key comes from the WebAuthn PRF output. The TEE never derives a
// holder's key. Tests and vectors do, to play the holder.
func DeriveKey(ikm []byte) (*PrivateKey, error) {
	if len(ikm) != kemID.Scheme().SeedSize() {
		return nil, fmt.Errorf("encryption: derive key needs %d bytes, got %d", kemID.Scheme().SeedSize(), len(ikm))
	}
	_, sk := kemID.Scheme().DeriveKeyPair(ikm)
	return wrap(sk)
}

func wrap(sk kem.PrivateKey) (*PrivateKey, error) {
	pub, err := sk.Public().MarshalBinary()
	if err != nil {
		return nil, fmt.Errorf("encryption: public key: %w", err)
	}
	return &PrivateKey{sk, pub}, nil
}

// PublicKey returns the 65-byte uncompressed public key.
func (k *PrivateKey) PublicKey() []byte { return append([]byte(nil), k.pub...) }

// ErrQuestionAAD is returned when a question is sealed or opened without its
// setter, because its aad is examId || passkeyPublicKey, not examId.
var ErrQuestionAAD = errors.New("encryption: a question's aad needs the setter's passkey, use SealQuestion and OpenQuestion")

// QuestionAAD is the aad of a question: examId || passkeyPublicKey. It ties the
// ciphertext to the setter who sent it, so another setter can't resubmit it.
func QuestionAAD(examID [32]byte, passkeyPublicKey []byte) []byte {
	return append(append(make([]byte, 0, 32+len(passkeyPublicKey)), examID[:]...), passkeyPublicKey...)
}

// Seal encrypts plaintext to a public key, framed as enc || ciphertext. The
// examId is the HPKE aad. A question has another aad, see SealQuestion.
func Seal(p Purpose, publicKey []byte, examID [32]byte, plaintext []byte) ([]byte, error) {
	return SealFrom(rand.Reader, p, publicKey, examID, plaintext)
}

// SealFrom is Seal with the randomness supplied. Only the test vectors pass
// anything but crypto/rand, to make their output repeatable.
func SealFrom(rnd io.Reader, p Purpose, publicKey []byte, examID [32]byte, plaintext []byte) ([]byte, error) {
	if p == PurposeQuestion {
		return nil, ErrQuestionAAD
	}
	return sealAAD(rnd, p, publicKey, examID[:], plaintext)
}

// SealQuestion encrypts a padded question for the TEE, with the aad the spec
// sets for it: examId || the setter's passkey public key.
func SealQuestion(publicKey []byte, examID [32]byte, passkeyPublicKey, plaintext []byte) ([]byte, error) {
	return SealQuestionFrom(rand.Reader, publicKey, examID, passkeyPublicKey, plaintext)
}

// SealQuestionFrom is SealQuestion with the randomness supplied, for vectors.
func SealQuestionFrom(rnd io.Reader, publicKey []byte, examID [32]byte, passkeyPublicKey, plaintext []byte) ([]byte, error) {
	if err := hashing.CheckPublicKey(passkeyPublicKey); err != nil {
		return nil, fmt.Errorf("encryption: setter: %w", err)
	}
	return sealAAD(rnd, PurposeQuestion, publicKey, QuestionAAD(examID, passkeyPublicKey), plaintext)
}

func sealAAD(rnd io.Reader, p Purpose, publicKey, aad, plaintext []byte) ([]byte, error) {
	info, err := p.info()
	if err != nil {
		return nil, err
	}
	if err := hashing.CheckPublicKey(publicKey); err != nil {
		return nil, fmt.Errorf("encryption: recipient: %w", err)
	}
	pk, err := kemID.Scheme().UnmarshalBinaryPublicKey(publicKey)
	if err != nil {
		return nil, fmt.Errorf("encryption: recipient: %w", err)
	}
	sender, err := suite.NewSender(pk, info)
	if err != nil {
		return nil, fmt.Errorf("encryption: sender: %w", err)
	}
	enc, sealer, err := sender.Setup(rnd)
	if err != nil {
		return nil, fmt.Errorf("encryption: setup: %w", err)
	}
	ct, err := sealer.Seal(plaintext, aad)
	if err != nil {
		return nil, fmt.Errorf("encryption: seal: %w", err)
	}
	return append(enc, ct...), nil
}

// Open decrypts an enc || ciphertext message whose aad is the examId. A
// question has another aad, see OpenQuestion.
func (k *PrivateKey) Open(p Purpose, examID [32]byte, framed []byte) ([]byte, error) {
	if p == PurposeQuestion {
		return nil, ErrQuestionAAD
	}
	return k.openAAD(p, examID[:], framed)
}

// OpenQuestion decrypts a question sent by the setter with this passkey.
func (k *PrivateKey) OpenQuestion(examID [32]byte, passkeyPublicKey, framed []byte) ([]byte, error) {
	return k.openAAD(PurposeQuestion, QuestionAAD(examID, passkeyPublicKey), framed)
}

func (k *PrivateKey) openAAD(p Purpose, aad, framed []byte) ([]byte, error) {
	info, err := p.info()
	if err != nil {
		return nil, err
	}
	encLen := kemID.Scheme().CiphertextSize()
	if len(framed) < encLen {
		return nil, ErrOpen
	}
	receiver, err := suite.NewReceiver(k.k, info)
	if err != nil {
		return nil, fmt.Errorf("encryption: receiver: %w", err)
	}
	opener, err := receiver.Setup(framed[:encLen])
	if err != nil {
		return nil, ErrOpen
	}
	pt, err := opener.Open(framed[encLen:], aad)
	if err != nil {
		return nil, ErrOpen
	}
	return pt, nil
}

// Package attestationtest is a stand-in for Google's token chain, with the same
// shape: leaf, intermediate, root. It signs tokens that attestation.Verifier
// accepts when given its root. It is for tests only, and the TEE never imports
// it. It exists so tests can run an Unlock instance without Google's key.
package attestationtest

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"strings"
	"sync"
	"testing"
	"time"

	"paperseal/tee/internal/attestation"
	"paperseal/tee/internal/settings"
	"paperseal/tee/internal/spec"
)

// PKI is a stand-in for Google's chain, with the same shape: leaf,
// intermediate, root. The Verifier takes the root as a parameter, so tests
// don't need Google's key.
type PKI struct {
	root      *x509.Certificate
	RootDER   []byte
	InterDER  []byte
	LeafDER   []byte
	leafKey   *rsa.PrivateKey
	notBefore time.Time
	notAfter  time.Time
}

func newCert(t *testing.T, tmpl, parent *x509.Certificate, pub *rsa.PublicKey, signer *rsa.PrivateKey) []byte {
	t.Helper()
	der, err := x509.CreateCertificate(rand.Reader, tmpl, parent, pub, signer)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func NewPKI(t *testing.T, notBefore, notAfter time.Time) *PKI {
	t.Helper()
	gen := func() *rsa.PrivateKey {
		k, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			t.Fatal(err)
		}
		return k
	}
	rootKey, interKey, leafKey := gen(), gen(), gen()
	mk := func(serial int64, cn string, ca bool) *x509.Certificate {
		return &x509.Certificate{
			SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: cn},
			NotBefore: notBefore, NotAfter: notAfter, IsCA: ca, BasicConstraintsValid: true,
			KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		}
	}
	rootT, interT, leafT := mk(1, "test root", true), mk(2, "test inter", true), mk(3, "test leaf", false)
	rootDER := newCert(t, rootT, rootT, &rootKey.PublicKey, rootKey)
	root, _ := x509.ParseCertificate(rootDER)
	interDER := newCert(t, interT, root, &interKey.PublicKey, rootKey)
	inter, _ := x509.ParseCertificate(interDER)
	leafDER := newCert(t, leafT, inter, &leafKey.PublicKey, interKey)
	return &PKI{root, rootDER, interDER, leafDER, leafKey, notBefore, notAfter}
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func (p *PKI) Token(t *testing.T, header, claims map[string]any) string {
	t.Helper()
	if _, ok := header["x5c"]; !ok {
		header["x5c"] = []string{
			base64.StdEncoding.EncodeToString(p.LeafDER),
			base64.StdEncoding.EncodeToString(p.InterDER),
			base64.StdEncoding.EncodeToString(p.RootDER),
		}
	}
	hb, _ := json.Marshal(header)
	cb, _ := json.Marshal(claims)
	signed := b64(hb) + "." + b64(cb)
	digest := sha256.Sum256([]byte(signed))
	sig, err := rsa.SignPKCS1v15(rand.Reader, p.leafKey, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return signed + "." + b64(sig)
}

// Bucket is the STORAGE_BUCKET in GoodClaims.
const Bucket = "b"

func TestExam(t *testing.T) settings.Exam {
	t.Helper()
	e, err := settings.Parse([]string{
		"--exam-id=0x" + strings.Repeat("11", 32), "--exam-start=1800000000", "--delta=1800",
		"--lock-round=100", "--unlock-round=35731612", "--end-round=35732300",
		"--criteria-hash=0x" + strings.Repeat("22", 32), "--rpc-host=rpc.example.com",
		"--registry=0x" + strings.Repeat("33", 20), "--chain-id=11155111",
	})
	if err != nil {
		t.Fatal(err)
	}
	return e
}

// GoodClaims are the claims of a token that passes every check for the exam,
// image digest and nonce.
func GoodClaims(t *testing.T, e settings.Exam, nonce string, digest [32]byte, iat time.Time) map[string]any {
	return map[string]any{
		"iss": spec.C.Attestation.Issuer, "aud": spec.C.Attestation.Audience, "iat": iat.Unix(), "exp": iat.Unix() + 3600,
		"eat_nonce": []string{nonce}, "swname": "CONFIDENTIAL_SPACE", "dbgstat": "disabled-since-boot",
		"hwmodel": "GCP_AMD_SEV", "secboot": true,
		"submods": map[string]any{
			"confidential_space": map[string]any{"support_attributes": []string{"LATEST", "STABLE", "USABLE"}},
			"container": map[string]any{
				"image_digest": "sha256:" + hex.EncodeToString(digest[:]),
				"args":         append([]string{"/tee"}, e.Args()...),
				"cmd_override": e.Args(),
				"env_override": map[string]string{"STORAGE_BUCKET": Bucket},
			},
		},
	}
}

// Root returns the root certificate a Verifier should trust.
func (p *PKI) Root() *x509.Certificate { return p.root }

// Verifier returns an attestation.Verifier that trusts this chain.
func (p *PKI) Verifier() *attestation.Verifier { return &attestation.Verifier{Root: p.root} }

// Source is a TokenSource for tests: it signs the token the launcher would
// have issued, with this PKI standing in for Google. It signs whatever nonce
// it is asked for, which is what the real launcher does.
type Source struct {
	PKI         *PKI
	T           *testing.T
	Exam        settings.Exam
	ImageDigest [32]byte
	// Unattested makes Token fail the way a missing launcher socket does.
	Unattested bool

	mu        sync.Mutex
	requested []attestation.TokenType
}

// Requested returns the token types asked for so far, in order.
func (s *Source) Requested() []attestation.TokenType {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]attestation.TokenType(nil), s.requested...)
}

var _ attestation.TokenSource = (*Source)(nil)

// Token implements attestation.TokenSource.
func (s *Source) Token(_ context.Context, tt attestation.TokenType, audience, nonce string) (attestation.Token, error) {
	s.mu.Lock()
	s.requested = append(s.requested, tt)
	s.mu.Unlock()
	if s.Unattested {
		return attestation.Token{}, attestation.ErrUnattested
	}
	c := GoodClaims(s.T, s.Exam, nonce, s.ImageDigest, time.Now())
	c["aud"] = audience
	return attestation.Token{Type: tt, Raw: s.PKI.Token(s.T, map[string]any{"alg": "RS256"}, c)}, nil
}

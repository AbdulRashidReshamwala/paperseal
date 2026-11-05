package attestation

import (
	"bytes"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"

	"paperseal/tee/internal/settings"
	"paperseal/tee/internal/spec"
)

// googleRoot is Google's Confidential Space PKI root, from the root_ca_uri in
// https://confidentialcomputing.googleapis.com/.well-known/attestation-pki-root.
// Its SHA-1 fingerprint is B9:51:20:74:2C:24:E3:AA:34:04:2E:1C:3B:A3:AA:D2:8B:21:23:21,
// as Google documents, and TestEmbeddedRoot pins it.
//
//go:embed confidential_space_root.pem
var googleRoot []byte

// GoogleRoot returns the embedded root certificate.
func GoogleRoot() (*x509.Certificate, error) {
	block, _ := pem.Decode(googleRoot)
	if block == nil {
		return nil, errors.New("attestation: embedded root is not PEM")
	}
	return x509.ParseCertificate(block.Bytes)
}

// entrypoint is the first element of the `args` claim: the full argv, which
// starts with the image's entrypoint, then the settings args.
const entrypoint = "/tee"

// Expect is what a published token must say.
type Expect struct {
	Exam              settings.Exam
	ImageDigest       [32]byte // The imageDigest recorded on-chain.
	InstancePublicKey []byte   // The key eat_nonce must bind.
	Bucket            string   // The STORAGE_BUCKET the operator set, which env_override must hold alone.
}

// Claims are the token claims this package reads.
type Claims struct {
	Issuer   string
	IssuedAt time.Time
}

type claimsJSON struct {
	Iss     string          `json:"iss"`
	Aud     json.RawMessage `json:"aud"`
	Iat     int64           `json:"iat"`
	Nonce   json.RawMessage `json:"eat_nonce"`
	SWName  string          `json:"swname"`
	DbgStat string          `json:"dbgstat"`
	HWModel string          `json:"hwmodel"`
	SecBoot bool            `json:"secboot"`
	Submods struct {
		CS struct {
			Support []string `json:"support_attributes"`
		} `json:"confidential_space"`
		Container struct {
			ImageDigest string            `json:"image_digest"`
			Args        []string          `json:"args"`
			CmdOverride []string          `json:"cmd_override"`
			EnvOverride map[string]string `json:"env_override"`
		} `json:"container"`
	} `json:"submods"`
}

// Verifier checks published PKI tokens against one root.
type Verifier struct {
	Root *x509.Certificate
}

// NewVerifier returns a Verifier for Google's embedded root.
func NewVerifier() (*Verifier, error) {
	root, err := GoogleRoot()
	if err != nil {
		return nil, err
	}
	return &Verifier{Root: root}, nil
}

type jwtHeader struct {
	Alg string   `json:"alg"`
	X5C []string `json:"x5c"`
}

// VerifyPKI checks a published token as a record. The certificate chain is
// checked as of the token's iat, and exp is ignored, because a published token
// is a record of when it was issued. Every claim in the README's table is
// checked.
func (v *Verifier) VerifyPKI(raw string, want Expect) (Claims, error) {
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return Claims{}, errors.New("attestation: token is not a JWT")
	}
	var h jwtHeader
	if err := decodeSegment(parts[0], &h); err != nil {
		return Claims{}, fmt.Errorf("attestation: token header: %w", err)
	}
	if h.Alg != "RS256" {
		return Claims{}, fmt.Errorf("attestation: token alg %q, want RS256", h.Alg)
	}
	var c claimsJSON
	if err := decodeSegment(parts[1], &c); err != nil {
		return Claims{}, fmt.Errorf("attestation: token claims: %w", err)
	}
	if c.Iat <= 0 {
		return Claims{}, errors.New("attestation: token has no iat")
	}
	iat := time.Unix(c.Iat, 0)
	leaf, err := v.verifyChain(h.X5C, iat)
	if err != nil {
		return Claims{}, err
	}
	pub, ok := leaf.PublicKey.(*rsa.PublicKey)
	if !ok {
		return Claims{}, errors.New("attestation: token signing key is not RSA")
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return Claims{}, errors.New("attestation: token signature is not base64url")
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, digest[:], sig); err != nil {
		return Claims{}, errors.New("attestation: token signature does not verify")
	}
	if err := checkClaims(c, want); err != nil {
		return Claims{}, err
	}
	return Claims{Issuer: c.Iss, IssuedAt: iat}, nil
}

func decodeSegment(s string, dst any) error {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, dst)
}

// verifyChain wants exactly leaf, intermediate and root, with the root equal to
// the one this verifier holds, valid as of at.
func (v *Verifier) verifyChain(x5c []string, at time.Time) (*x509.Certificate, error) {
	if len(x5c) != 3 {
		return nil, fmt.Errorf("attestation: x5c has %d certificates, want 3", len(x5c))
	}
	certs := make([]*x509.Certificate, 3)
	for i, s := range x5c {
		der, err := base64.StdEncoding.DecodeString(s)
		if err != nil {
			return nil, fmt.Errorf("attestation: x5c[%d] is not base64", i)
		}
		if certs[i], err = x509.ParseCertificate(der); err != nil {
			return nil, fmt.Errorf("attestation: x5c[%d]: %w", i, err)
		}
	}
	if !bytes.Equal(certs[2].Raw, v.Root.Raw) {
		return nil, errors.New("attestation: token chain does not end at Google's root")
	}
	roots := x509.NewCertPool()
	roots.AddCert(v.Root)
	inter := x509.NewCertPool()
	inter.AddCert(certs[1])
	_, err := certs[0].Verify(x509.VerifyOptions{
		Roots: roots, Intermediates: inter, CurrentTime: at,
		KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny},
	})
	if err != nil {
		return nil, fmt.Errorf("attestation: token chain: %w", err)
	}
	return certs[0], nil
}

func checkClaims(c claimsJSON, want Expect) error {
	a := spec.C.Attestation
	if c.Iss != a.Issuer {
		return fmt.Errorf("attestation: iss is %q", c.Iss)
	}
	if !listHas(c.Aud, a.Audience) {
		return errors.New("attestation: aud is not Paper Seal's audience")
	}
	if c.SWName != a.SWName {
		return fmt.Errorf("attestation: swname is %q", c.SWName)
	}
	if c.DbgStat != a.DbgStat {
		return fmt.Errorf("attestation: dbgstat is %q", c.DbgStat)
	}
	if !slices.Contains(a.HWModels, c.HWModel) {
		return fmt.Errorf("attestation: hwmodel %q is not an approved Confidential VM type", c.HWModel)
	}
	if !c.SecBoot {
		return errors.New("attestation: secboot is false")
	}
	if !slices.Contains(c.Submods.CS.Support, a.SupportAttribute) {
		return fmt.Errorf("attestation: support_attributes lacks %s", a.SupportAttribute)
	}
	k := c.Submods.Container
	if k.ImageDigest != "sha256:"+hex.EncodeToString(want.ImageDigest[:]) {
		return fmt.Errorf("attestation: image digest %q is not the one on-chain", k.ImageDigest)
	}
	args := want.Exam.Args()
	if !slices.Equal(k.Args, append([]string{entrypoint}, args...)) {
		return errors.New("attestation: container args differ from /tee and the exam settings")
	}
	if !slices.Equal(k.CmdOverride, args) {
		return errors.New("attestation: cmd_override differs from the exam settings")
	}
	// env is not compared: it also holds the base image's variables. Only
	// env_override shows what the operator set.
	if !maps.Equal(k.EnvOverride, map[string]string{"STORAGE_BUCKET": want.Bucket}) {
		return errors.New("attestation: env_override is not exactly STORAGE_BUCKET")
	}
	nonce, err := Nonce(want.InstancePublicKey, want.Exam.ExamID)
	if err != nil {
		return err
	}
	if !listHas(c.Nonce, nonce) {
		return errors.New("attestation: eat_nonce does not bind the instance key and exam")
	}
	return nil
}

// listHas reports whether a claim that may be one string or a list holds s.
func listHas(raw json.RawMessage, s string) bool {
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return one == s
	}
	var many []string
	if json.Unmarshal(raw, &many) == nil {
		return slices.Contains(many, s)
	}
	return false
}

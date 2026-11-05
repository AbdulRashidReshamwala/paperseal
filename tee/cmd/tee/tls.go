package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"time"
)

// certHost is the name the Cloudflare zone uses for the TEE.
const certHost = "tee.abdulrashid.dev"

// selfSignedConfig makes a fresh in-memory P-256 key and a self-signed
// certificate for the TLS listener. Nothing is written to disk.
//
// The certificate has no trust role. Cloudflare's zone (Full mode) only needs
// the origin to speak HTTPS so the hop is never downgraded to plain HTTP. Apps
// do not rely on it: they trust the attestation token and HPKE encryption to
// the key it binds, so a different or stolen certificate gains an attacker
// nothing. Because of that it is valid for any host.
func selfSignedConfig() (*tls.Config, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return nil, err
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: certHost},
		DNSNames:              []string{certHost},
		IPAddresses:           []net.IP{net.IPv4zero, net.IPv6unspecified, net.IPv4(127, 0, 0, 1), net.IPv6loopback},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.AddDate(1, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}},
	}, nil
}

package attestation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

// DefaultSocket is where Confidential Space puts the launcher's token service.
const DefaultSocket = "/run/container_launcher/teeserver.sock"

// ErrUnattested means the launcher socket is missing, so this instance isn't
// running in Confidential Space and can't be attested.
var ErrUnattested = errors.New("attestation: not running in Confidential Space, so the instance is unattested")

// Launcher is the real TokenSource: Google's Confidential Space launcher, over
// its Unix socket.
type Launcher struct {
	// Socket defaults to DefaultSocket.
	Socket string
}

var _ TokenSource = Launcher{}

// tokenRequest is the body of POST /v1/token. The audience is chosen by the
// workload, and each nonce must be 10 to 74 bytes.
type tokenRequest struct {
	Audience  string    `json:"audience"`
	TokenType TokenType `json:"token_type"`
	Nonces    []string  `json:"nonces"`
}

// Token asks the launcher for a token whose audience is the given one and whose
// eat_nonce holds the nonce.
func (l Launcher) Token(ctx context.Context, tokenType TokenType, audience, nonce string) (Token, error) {
	if tokenType != TokenOIDC && tokenType != TokenPKI {
		return Token{}, fmt.Errorf("attestation: unknown token type %q", tokenType)
	}
	socket := l.Socket
	if socket == "" {
		socket = DefaultSocket
	}
	if _, err := os.Stat(socket); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Token{}, ErrUnattested
		}
		return Token{}, fmt.Errorf("attestation: launcher socket: %w", err)
	}
	body, err := json.Marshal(tokenRequest{audience, tokenType, []string{nonce}})
	if err != nil {
		return Token{}, err
	}
	client := &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", socket)
			},
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://localhost/v1/token", bytes.NewReader(body))
	if err != nil {
		return Token{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return Token{}, fmt.Errorf("attestation: launcher request: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return Token{}, fmt.Errorf("attestation: launcher response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return Token{}, fmt.Errorf("attestation: launcher returned %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	tok := strings.TrimSpace(string(raw))
	if strings.Count(tok, ".") != 2 {
		return Token{}, errors.New("attestation: launcher response is not a JWT")
	}
	return Token{Type: tokenType, Raw: tok}, nil
}

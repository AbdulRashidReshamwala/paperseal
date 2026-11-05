package storage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	gcsUpload   = "https://storage.googleapis.com/upload/storage/v1/b"
	gcsDownload = "https://storage.googleapis.com"
	// The workload's service account token comes from the metadata server.
	metadataToken = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
	maxFile       = 16 << 20
)

// Bucket is a Store on a public Google Cloud Storage bucket. It uses the JSON
// API over HTTP, so the TEE needs no Google client library. Writes carry the
// workload service account's token from the metadata server. Reads are
// anonymous, because the bucket is public.
type Bucket struct {
	Name   string
	Client *http.Client

	// Test hooks. Zero values are the Google endpoints.
	UploadURL, DownloadURL, TokenURL string

	mu      sync.Mutex
	token   string
	expires time.Time
}

var _ Store = (*Bucket)(nil)

func (b *Bucket) client() *http.Client {
	if b.Client != nil {
		return b.Client
	}
	return &http.Client{Timeout: 60 * time.Second}
}

func or(v, def string) string {
	if v != "" {
		return v
	}
	return def
}

func (b *Bucket) accessToken(ctx context.Context) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.token != "" && time.Now().Before(b.expires.Add(-time.Minute)) {
		return b.token, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, or(b.TokenURL, metadataToken), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Metadata-Flavor", "Google")
	resp, err := b.client().Do(req)
	if err != nil {
		return "", fmt.Errorf("storage: metadata token: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("storage: metadata token: status %d", resp.StatusCode)
	}
	var t struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&t); err != nil || t.AccessToken == "" {
		return "", errors.New("storage: metadata token: bad response")
	}
	b.token, b.expires = t.AccessToken, time.Now().Add(time.Duration(t.ExpiresIn)*time.Second)
	return b.token, nil
}

func contentType(name string) string {
	switch {
	case strings.HasSuffix(name, ".json"):
		return "application/json"
	case strings.HasSuffix(name, ".jwt"), strings.HasSuffix(name, ".tlock"):
		return "text/plain"
	}
	return "application/octet-stream"
}

// Put uploads one object, replacing any earlier one of that name, so a retry
// after a partial failure is safe.
func (b *Bucket) Put(ctx context.Context, name string, data []byte) error {
	if err := checkName(name); err != nil {
		return err
	}
	if len(data) > maxFile {
		return errors.New("storage: file too large")
	}
	token, err := b.accessToken(ctx)
	if err != nil {
		return err
	}
	u := fmt.Sprintf("%s/%s/o?uploadType=media&name=%s", or(b.UploadURL, gcsUpload),
		url.PathEscape(b.Name), url.QueryEscape(name))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", contentType(name))
	resp, err := b.client().Do(req)
	if err != nil {
		return fmt.Errorf("storage: upload %s: %w", name, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<10))
		return fmt.Errorf("storage: upload %s: status %d: %s", name, resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	return nil
}

// Get reads an object from the public URL.
func (b *Bucket) Get(ctx context.Context, name string) ([]byte, error) {
	if err := checkName(name); err != nil {
		return nil, err
	}
	segs := strings.Split(name, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	u := fmt.Sprintf("%s/%s/%s", or(b.DownloadURL, gcsDownload), url.PathEscape(b.Name), strings.Join(segs, "/"))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := b.client().Do(req)
	if err != nil {
		return nil, fmt.Errorf("storage: download %s: %w", name, err)
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return nil, ErrNotFound
	default:
		return nil, fmt.Errorf("storage: download %s: status %d", name, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxFile+1))
	if err != nil {
		return nil, fmt.Errorf("storage: download %s: %w", name, err)
	}
	if len(data) > maxFile {
		return nil, errors.New("storage: file too large")
	}
	return data, nil
}

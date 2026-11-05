package storage

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ErrExists is returned by Put when the name already holds other content.
var ErrExists = errors.New("storage: file already exists with different content")

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

// Put creates one object. It is create-only (ifGenerationMatch=0), so nothing
// the TEE has published can be replaced. A retry after a lost reply is safe:
// the object then exists, the server says 412, and Put reads it back. If it
// holds exactly these bytes the write counts as done, and any other content is
// ErrExists. The server's crc32c of what it stored is checked against the
// bytes sent, so a corrupted upload is an error.
func (b *Bucket) Put(ctx context.Context, name string, data []byte) error {
	return b.upload(ctx, name, data, true)
}

// Replace uploads an unlock file whether or not it exists, see IsUnlockFile.
// The reply's crc32c is checked as for Put. Any other name is refused.
func (b *Bucket) Replace(ctx context.Context, name string, data []byte) error {
	if err := checkName(name); err != nil {
		return err
	}
	if !IsUnlockFile(name) {
		return fmt.Errorf("storage: %s is not an unlock file and can't be replaced", name)
	}
	return b.upload(ctx, name, data, false)
}

func (b *Bucket) upload(ctx context.Context, name string, data []byte, createOnly bool) error {
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
	cond := ""
	if createOnly {
		cond = "&ifGenerationMatch=0"
	}
	u := fmt.Sprintf("%s/%s/o?uploadType=media%s&name=%s", or(b.UploadURL, gcsUpload),
		url.PathEscape(b.Name), cond, url.QueryEscape(name))
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
	switch resp.StatusCode {
	case http.StatusOK:
		return checkUploaded(name, data, resp.Body)
	case http.StatusPreconditionFailed:
		got, err := b.Get(ctx, name)
		if err != nil {
			return fmt.Errorf("storage: upload %s: it exists and could not be read back: %w", name, err)
		}
		if !bytes.Equal(got, data) {
			return fmt.Errorf("%w: %s", ErrExists, name)
		}
		return nil
	}
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<10))
	return fmt.Errorf("storage: upload %s: status %d: %s", name, resp.StatusCode, strings.TrimSpace(string(msg)))
}

// checkUploaded compares the object's metadata in the reply with the bytes
// sent. crc32c is Castagnoli, as base64 of the big-endian value.
func checkUploaded(name string, data []byte, body io.Reader) error {
	var meta struct {
		CRC32C string `json:"crc32c"`
		Size   string `json:"size"`
	}
	if err := json.NewDecoder(io.LimitReader(body, 1<<16)).Decode(&meta); err != nil {
		return fmt.Errorf("storage: upload %s: unreadable reply: %w", name, err)
	}
	if meta.CRC32C == "" {
		return fmt.Errorf("storage: upload %s: the reply has no crc32c to check", name)
	}
	var want [4]byte
	binary.BigEndian.PutUint32(want[:], crc32.Checksum(data, crc32.MakeTable(crc32.Castagnoli)))
	if meta.CRC32C != base64.StdEncoding.EncodeToString(want[:]) {
		return fmt.Errorf("storage: upload %s: the stored object's crc32c is not the bytes sent", name)
	}
	if meta.Size != "" && meta.Size != fmt.Sprint(len(data)) {
		return fmt.Errorf("storage: upload %s: stored size %s, sent %d", name, meta.Size, len(data))
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

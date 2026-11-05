package storage

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestDir(t *testing.T) {
	root := t.TempDir()
	d := Dir{root}
	ctx := context.Background()
	if err := d.Put(ctx, "0xab/shares/0x04.bin", []byte("one")); err != nil {
		t.Fatal(err)
	}
	if err := d.Put(ctx, "0xab/shares/0x04.bin", []byte("two")); err != nil {
		t.Fatal(err)
	}
	got, err := d.Get(ctx, "0xab/shares/0x04.bin")
	if err != nil || string(got) != "two" {
		t.Fatalf("get: %q %v", got, err)
	}
	if _, err := d.Get(ctx, "0xab/none"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	// No temporary files are left behind.
	entries, _ := os.ReadDir(filepath.Join(root, "0xab", "shares"))
	if len(entries) != 1 {
		t.Fatalf("leftover files: %v", entries)
	}
	for _, bad := range []string{"", "/abs", "../x", "a/../../x", "a//b", "a/./b", "a\\b", "."} {
		if err := d.Put(ctx, bad, nil); err == nil {
			t.Errorf("accepted name %q", bad)
		}
		if _, err := d.Get(ctx, bad); err == nil {
			t.Errorf("read name %q", bad)
		}
	}
}

func TestBucketAgainstTheJSONAPI(t *testing.T) {
	var tokens atomic.Int32
	var gotName, gotAuth, gotType, gotBody, gotPath string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/token"):
			tokens.Add(1)
			if r.Header.Get("Metadata-Flavor") != "Google" {
				http.Error(w, "no flavor", http.StatusForbidden)
				return
			}
			w.Write([]byte(`{"access_token":"tok","expires_in":3600}`))
		case r.Method == http.MethodPost:
			b, _ := io.ReadAll(r.Body)
			gotName, gotAuth, gotType, gotBody, gotPath = r.URL.Query().Get("name"), r.Header.Get("Authorization"), r.Header.Get("Content-Type"), string(b), r.URL.Path
			if r.URL.Query().Get("uploadType") != "media" {
				http.Error(w, "bad", 400)
				return
			}
			w.Write([]byte(`{}`))
		case r.URL.Path == "/bkt/0xab/paper.bin":
			w.Write([]byte("public bytes"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer api.Close()
	b := &Bucket{Name: "bkt", Client: api.Client(), UploadURL: api.URL + "/upload", DownloadURL: api.URL, TokenURL: api.URL + "/token"}
	ctx := context.Background()
	if err := b.Put(ctx, "0xab/manifest.json", []byte("{}")); err != nil {
		t.Fatal(err)
	}
	if gotName != "0xab/manifest.json" || gotAuth != "Bearer tok" || gotType != "application/json" || gotBody != "{}" || gotPath != "/upload/bkt/o" {
		t.Fatalf("upload: %q %q %q %q %q", gotName, gotAuth, gotType, gotBody, gotPath)
	}
	if err := b.Put(ctx, "0xab/paper.bin", []byte("x")); err != nil {
		t.Fatal(err)
	}
	if tokens.Load() != 1 {
		t.Fatalf("token fetched %d times, want it cached", tokens.Load())
	}
	got, err := b.Get(ctx, "0xab/paper.bin")
	if err != nil || string(got) != "public bytes" {
		t.Fatalf("get: %q %v", got, err)
	}
	if _, err := b.Get(ctx, "0xab/missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if err := b.Put(ctx, "../x", nil); err == nil {
		t.Fatal("accepted a bad name")
	}
	// Without a token the write fails and nothing is sent.
	api2 := httptest.NewServer(http.NotFoundHandler())
	defer api2.Close()
	b2 := &Bucket{Name: "bkt", UploadURL: api2.URL, TokenURL: api2.URL + "/token"}
	if err := b2.Put(ctx, "a/b", nil); err == nil {
		t.Fatal("wrote without a token")
	}
}

func TestManifest(t *testing.T) {
	var exam [32]byte
	exam[0] = 1
	m := NewManifest(exam, []ManifestFile{
		{Name: "token.jwt", SHA256: "0x02"},
		{Name: "paper.bin", SHA256: "0x01"},
		{Name: "shares/0x04.bin", SHA256: "0x03", Recipient: "0x04", ShareHash: "0x05"},
	})
	b, err := m.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	want := `{"examId":"0x0100000000000000000000000000000000000000000000000000000000000000","files":[` +
		`{"name":"paper.bin","sha256":"0x01"},` +
		`{"name":"shares/0x04.bin","sha256":"0x03","recipient":"0x04","shareHash":"0x05"},` +
		`{"name":"token.jwt","sha256":"0x02"}]}`
	if string(b) != want {
		t.Fatalf("manifest:\n%s\nwant\n%s", b, want)
	}
	back, err := ParseManifest(b)
	if err != nil || len(back.Files) != 3 {
		t.Fatalf("parse: %v", err)
	}
	if f, ok := back.File("token.jwt"); !ok || f.SHA256 != "0x02" {
		t.Fatal("File lookup")
	}
	for name, bad := range map[string]string{
		"unsorted": `{"examId":"0x01","files":[{"name":"b","sha256":"0x"},{"name":"a","sha256":"0x"}]}`,
		"repeat":   `{"examId":"0x01","files":[{"name":"a","sha256":"0x"},{"name":"a","sha256":"0x"}]}`,
		"unknown":  `{"examId":"0x01","files":[],"x":1}`,
		"trailing": `{"examId":"0x01","files":[]} {}`,
	} {
		if _, err := ParseManifest([]byte(bad)); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

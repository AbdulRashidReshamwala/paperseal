package storage

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
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
	var gotName, gotAuth, gotType, gotBody, gotPath, gotMatch string
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
			gotMatch = r.URL.Query().Get("ifGenerationMatch")
			if r.URL.Query().Get("uploadType") != "media" {
				http.Error(w, "bad", 400)
				return
			}
			w.Write(uploadReply(b))
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
	if gotMatch != "0" {
		t.Fatalf("ifGenerationMatch=%q, want 0 so the upload only creates", gotMatch)
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

// uploadReply is the object metadata GCS returns, with the crc32c of data.
func uploadReply(data []byte) []byte {
	var c [4]byte
	binary.BigEndian.PutUint32(c[:], crc32.Checksum(data, crc32.MakeTable(crc32.Castagnoli)))
	return []byte(fmt.Sprintf(`{"size":"%d","crc32c":"%s"}`, len(data), base64.StdEncoding.EncodeToString(c[:])))
}

// fakeGCS holds objects, refuses a create over an existing name with 412, and
// can corrupt what it reports back.
type fakeGCS struct {
	mu      sync.Mutex
	objects map[string][]byte
	lose    bool // Store the object but answer 500, as a lost reply does.
	badCRC  bool
	posts   int
}

func (f *fakeGCS) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case strings.HasPrefix(r.URL.Path, "/token"):
		w.Write([]byte(`{"access_token":"tok","expires_in":3600}`))
	case r.Method == http.MethodPost:
		f.posts++
		name := r.URL.Query().Get("name")
		b, _ := io.ReadAll(r.Body)
		if r.URL.Query().Get("ifGenerationMatch") != "0" {
			f.objects[name] = b // An unconditional write replaces.
		} else if _, ok := f.objects[name]; ok {
			http.Error(w, "exists", http.StatusPreconditionFailed)
			return
		} else {
			f.objects[name] = b
		}
		if f.lose {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		reply := uploadReply(b)
		if f.badCRC {
			reply = uploadReply([]byte("not what was sent"))
		}
		w.Write(reply)
	default:
		if b, ok := f.objects[strings.TrimPrefix(r.URL.Path, "/bkt/")]; ok {
			w.Write(b)
			return
		}
		http.NotFound(w, r)
	}
}

func fakeBucket(t *testing.T) (*Bucket, *fakeGCS) {
	f := &fakeGCS{objects: map[string][]byte{}}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return &Bucket{Name: "bkt", Client: srv.Client(), UploadURL: srv.URL + "/upload", DownloadURL: srv.URL, TokenURL: srv.URL + "/token"}, f
}

func TestBucketNeverReplaces(t *testing.T) {
	b, f := fakeBucket(t)
	ctx := context.Background()
	if err := b.Put(ctx, "0x1/paper.bin", []byte("one")); err != nil {
		t.Fatal(err)
	}
	// The same bytes again is a safe retry.
	if err := b.Put(ctx, "0x1/paper.bin", []byte("one")); err != nil {
		t.Fatalf("retry of the same bytes: %v", err)
	}
	// Different bytes would replace a published file.
	if err := b.Put(ctx, "0x1/paper.bin", []byte("two")); !errors.Is(err, ErrExists) {
		t.Fatalf("replacement: %v", err)
	}
	if string(f.objects["0x1/paper.bin"]) != "one" {
		t.Fatal("the stored file changed")
	}
}

func TestBucketRetryAfterALostReply(t *testing.T) {
	b, f := fakeBucket(t)
	f.lose = true
	if err := b.Put(context.Background(), "0x1/a", []byte("data")); err == nil {
		t.Fatal("a 500 was taken as success")
	}
	f.lose = false
	if err := b.Put(context.Background(), "0x1/a", []byte("data")); err != nil {
		t.Fatalf("retry after the write had landed: %v", err)
	}
}

func TestBucketChecksTheReturnedHash(t *testing.T) {
	b, f := fakeBucket(t)
	f.badCRC = true
	if err := b.Put(context.Background(), "0x1/a", []byte("data")); err == nil || !strings.Contains(err.Error(), "crc32c") {
		t.Fatalf("a wrong crc32c was accepted: %v", err)
	}
	// A reply with no hash at all can't be checked either.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/token") {
			w.Write([]byte(`{"access_token":"tok","expires_in":3600}`))
			return
		}
		w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	b2 := &Bucket{Name: "bkt", Client: srv.Client(), UploadURL: srv.URL, DownloadURL: srv.URL, TokenURL: srv.URL + "/token"}
	if err := b2.Put(context.Background(), "0x1/a", []byte("data")); err == nil {
		t.Fatal("a reply without a hash was accepted")
	}
}

func TestDirSyncsFileThenRenameThenFolder(t *testing.T) {
	var calls []string
	oldFile, oldDir := syncFile, syncDir
	defer func() { syncFile, syncDir = oldFile, oldDir }()
	root := t.TempDir()
	syncFile = func(f *os.File) error {
		if _, err := os.Stat(filepath.Join(root, "x", "f")); err == nil {
			t.Error("the file was already renamed when the data was synced")
		}
		calls = append(calls, "file")
		return f.Sync()
	}
	syncDir = func(path string) error {
		if b, err := os.ReadFile(filepath.Join(root, "x", "f")); err != nil || string(b) != "data" {
			t.Errorf("the folder was synced before the rename: %v", err)
		}
		if path != filepath.Join(root, "x") {
			t.Errorf("synced %q", path)
		}
		calls = append(calls, "dir")
		return nil
	}
	if err := (Dir{root}).Put(context.Background(), "x/f", []byte("data")); err != nil {
		t.Fatal(err)
	}
	if strings.Join(calls, ",") != "file,dir" {
		t.Fatalf("calls %v", calls)
	}
	// A failed sync is a failed write, and leaves no temporary file.
	syncFile = func(*os.File) error { return errors.New("disk") }
	if err := (Dir{root}).Put(context.Background(), "x/g", []byte("d")); err == nil {
		t.Fatal("a failed sync was ignored")
	}
	if entries, _ := os.ReadDir(filepath.Join(root, "x")); len(entries) != 1 {
		t.Fatalf("leftovers: %v", entries)
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

func TestIsUnlockFile(t *testing.T) {
	for _, name := range []string{"0xab/key-priv/0x04.bin", "0xab/key-priv.tlock", "0xab/release-log.json", "0xab/release-token.jwt"} {
		if !IsUnlockFile(name) {
			t.Errorf("%s should be replaceable", name)
		}
	}
	// Everything the manifest lists stays create-only.
	for _, name := range []string{"0xab/paper.bin", "0xab/key-pub.tlock", "0xab/shares/0x04.bin", "0xab/token.jwt",
		"0xab/manifest.json", "key-priv.tlock", "0xab/key-priv/", "0xab/key-priv/a/b", "0xab/x/key-priv.tlock", ""} {
		if IsUnlockFile(name) {
			t.Errorf("%s must not be replaceable", name)
		}
	}
}

func TestBucketReplaceIsOnlyForUnlockFiles(t *testing.T) {
	b, f := fakeBucket(t)
	ctx := context.Background()
	if err := b.Put(ctx, "0x1/key-priv/0x04.bin", []byte("first")); err != nil {
		t.Fatal(err)
	}
	if err := b.Put(ctx, "0x1/key-priv/0x04.bin", []byte("second")); !errors.Is(err, ErrExists) {
		t.Fatalf("Put must stay create-only: %v", err)
	}
	if err := b.Replace(ctx, "0x1/key-priv/0x04.bin", []byte("second")); err != nil {
		t.Fatalf("replace: %v", err)
	}
	if string(f.objects["0x1/key-priv/0x04.bin"]) != "second" {
		t.Fatal("not replaced")
	}
	if err := b.Put(ctx, "0x1/paper.bin", []byte("paper")); err != nil {
		t.Fatal(err)
	}
	if err := b.Replace(ctx, "0x1/paper.bin", []byte("other")); err == nil {
		t.Fatal("a manifest file was replaced")
	}
	if err := b.Replace(ctx, "0x1/manifest.json", []byte("{}")); err == nil {
		t.Fatal("the manifest was replaced")
	}
	if string(f.objects["0x1/paper.bin"]) != "paper" {
		t.Fatal("paper.bin changed")
	}
	f.badCRC = true
	if err := b.Replace(ctx, "0x1/key-priv.tlock", []byte("x")); err == nil {
		t.Fatal("Replace skipped the crc32c check")
	}
	d := Dir{t.TempDir()}
	if err := d.Replace(ctx, "0x1/paper.bin", []byte("x")); err == nil {
		t.Fatal("Dir replaced a manifest file")
	}
	if err := d.Replace(ctx, "0x1/release-log.json", []byte("x")); err != nil {
		t.Fatal(err)
	}
}

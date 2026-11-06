package vectors

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"strings"
	"testing"

	"paperseal/tee/internal/approvedlist"
	"paperseal/tee/internal/criteria"
	"paperseal/tee/internal/encryption"
	"paperseal/tee/internal/release"
	"paperseal/tee/internal/storage"
)

const path = "../../testdata/vectors.json"

var update = flag.Bool("update", false, "rewrite testdata/vectors.json")

// A change to the encoding fails here, so it can't reach other languages
// unnoticed.
func TestVectorsAreCurrent(t *testing.T) {
	f, err := Build()
	if err != nil {
		t.Fatal(err)
	}
	got, err := Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	if *update {
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("testdata/vectors.json is stale: if the change is deliberate, run go test ./internal/vectors -update")
	}
}

// The sample must parse and be canonical, and fail only on its counts, as the
// file says.
func TestSampleFailsOnlyOnHolderCounts(t *testing.T) {
	f, err := Build()
	if err != nil {
		t.Fatal(err)
	}
	entries, err := hex.DecodeString(strings.TrimPrefix(f.ApprovedList.Entries, "0x"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := approvedlist.Decode(entries); !errors.Is(err, approvedlist.ErrHolderCount) {
		t.Fatalf("want the holder count rejection, got %v", err)
	}
}

func TestCriteriaSampleDecodes(t *testing.T) {
	f, err := Build()
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := hex.DecodeString(strings.TrimPrefix(f.Criteria.Encoded, "0x"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := criteria.Decode(encoded); err != nil {
		t.Fatal(err)
	}
}

func TestSampleHasOneEntryPerRole(t *testing.T) {
	seen := map[approvedlist.Role]int{}
	for _, e := range SamplePerRole() {
		seen[e.Role]++
	}
	for _, role := range []approvedlist.Role{
		approvedlist.RoleSetter, approvedlist.RoleNeutral, approvedlist.RoleCentreHolder, approvedlist.RoleCentre,
	} {
		if seen[role] != 1 {
			t.Errorf("role %d: %d entries", role, seen[role])
		}
	}
}

func unhex0x(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(strings.TrimPrefix(s, "0x"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// Read back from the file, as another language would: every sealed vector must
// open from its recipient's input keying material.
func TestSealedVectorsOpenFromTheFile(t *testing.T) {
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var f File
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.HPKE) != 4 {
		t.Fatalf("%d hpke vectors", len(f.HPKE))
	}
	purposes := map[string]encryption.Purpose{
		"question": encryption.PurposeQuestion, "share": encryption.PurposeShare,
		"release": encryption.PurposeRelease, "keyPriv": encryption.PurposeKeyPriv,
	}
	for _, v := range f.HPKE {
		key, err := encryption.DeriveKey(unhex0x(t, v.RecipientIKM))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(key.PublicKey(), unhex0x(t, v.RecipientPublicKey)) {
			t.Errorf("%s: derived key differs", v.Purpose)
		}
		var exam [32]byte
		copy(exam[:], unhex0x(t, v.ExamID))
		var got []byte
		if v.Purpose == "question" {
			// The aad is examId || the setter's passkey public key.
			passkey := unhex0x(t, v.PasskeyPublicKey)
			if !bytes.Equal(unhex0x(t, v.AAD), append(exam[:], passkey...)) {
				t.Errorf("question: aad is not examId || passkeyPublicKey")
			}
			got, err = key.OpenQuestion(exam, passkey, unhex0x(t, v.Sealed))
			if _, bad := key.OpenQuestion(exam, pubKey(2), unhex0x(t, v.Sealed)); bad == nil {
				t.Errorf("question: opened for another setter")
			}
		} else {
			if !bytes.Equal(unhex0x(t, v.AAD), exam[:]) {
				t.Errorf("%s: aad is not examId", v.Purpose)
			}
			got, err = key.Open(purposes[v.Purpose], exam, unhex0x(t, v.Sealed))
		}
		if err != nil || !bytes.Equal(got, unhex0x(t, v.Plaintext)) {
			t.Errorf("%s: did not open: %v", v.Purpose, err)
		}
	}
	var exam [32]byte
	copy(exam[:], unhex0x(t, f.AES.ExamID))
	got, err := encryption.OpenAES(unhex0x(t, f.AES.Key), exam, unhex0x(t, f.AES.Sealed))
	if err != nil || !bytes.Equal(got, unhex0x(t, f.AES.Plaintext)) {
		t.Errorf("aes: %v", err)
	}
	for _, p := range f.Padding {
		if p.Padded == "" {
			if _, err := encryption.Pad(unhex0x(t, p.Data), p.Size); err == nil {
				t.Error("padded data that doesn't fit")
			}
			continue
		}
		data, err := encryption.Unpad(unhex0x(t, p.Padded), p.Size)
		if err != nil || !bytes.Equal(data, unhex0x(t, p.Data)) {
			t.Errorf("padding: %v", err)
		}
	}
	share, a, err := release.DecodeRelease(unhex0x(t, f.Release.Encoded))
	if err != nil || !bytes.Equal(share, unhex0x(t, f.Release.Share)) || !bytes.Equal(a.ClientDataJSON, unhex0x(t, f.Release.ClientDataJSON)) {
		t.Errorf("release plaintext: %v", err)
	}
	sum := sha256.Sum256(unhex0x(t, f.ReleaseEntries.Preimage))
	if x(sum[:]) != f.ReleaseEntries.EntriesHash {
		t.Error("entriesHash is not the SHA-256 of its preimage")
	}
	checkReleaseFiles(t, f.ReleaseFiles)
	msum := sha256.Sum256([]byte(f.Manifest.Manifest))
	if x(msum[:]) != f.Manifest.Hash {
		t.Error("manifest hash")
	}
	if _, err := storage.ParseManifest([]byte(f.Manifest.Manifest)); err != nil {
		t.Errorf("manifest: %v", err)
	}
}

func checkReleaseFiles(t *testing.T, v FilesVector) {
	t.Helper()
	var files []release.File
	for i, j := range v.Files {
		file := release.File{Name: j.Name}
		copy(file.SHA256[:], unhex0x(t, j.SHA256))
		files = append(files, file)
		if i > 0 && !(v.Files[i-1].Name < j.Name) {
			t.Errorf("files are not in byte order at %q", j.Name)
		}
	}
	// The order is byte order, not a locale's: the punctuation and the case
	// both matter here.
	names := make([]string, len(v.Files))
	for i, j := range v.Files {
		names[i] = j.Name
	}
	if len(names) != 4 || names[0] != "key-priv.tlock" || names[2] != "key-priv/Z.bin" || names[3] != "key-priv/a.bin" {
		t.Errorf("names: %v", names)
	}
	pre, err := release.FilesPreimage(files)
	if err != nil || x(pre) != v.Preimage {
		t.Errorf("files preimage: %v", err)
	}
	sum := sha256.Sum256(unhex0x(t, v.Preimage))
	if x(sum[:]) != v.FilesHash {
		t.Error("filesHash is not the SHA-256 of its preimage")
	}
	empty := sha256.Sum256(unhex0x(t, v.EmptyPreimage))
	if x(empty[:]) != v.EmptyFilesHash {
		t.Error("the empty filesHash is not the SHA-256 of its preimage")
	}
	// An empty array is its offset and a zero length.
	if want := "0x" + strings.Repeat("0", 62) + "20" + strings.Repeat("0", 64); v.EmptyPreimage != want {
		t.Errorf("empty preimage %s", v.EmptyPreimage)
	}
	// Input out of order is refused, not quietly sorted.
	reversed := []release.File{files[1], files[0]}
	if _, err := release.FilesHash(reversed); err == nil {
		t.Error("hashed files out of order")
	}
	if _, err := release.FilesHash([]release.File{files[0], files[0]}); err == nil {
		t.Error("hashed a repeated name")
	}
}

// The reject inputs must fail as the file says: by size, or by layout, which
// is ErrMalformed before any decoding.
func TestLimitsVectorsAreRejected(t *testing.T) {
	f, err := Build()
	if err != nil {
		t.Fatal(err)
	}
	if len(f.Limits.Reject) == 0 {
		t.Fatal("no reject vectors")
	}
	for _, r := range f.Limits.Reject {
		b, err := r.Bytes()
		if err != nil {
			t.Fatal(err)
		}
		var got, tooLarge, malformed error
		switch r.Kind {
		case "entries":
			_, got = approvedlist.Decode(b)
			tooLarge, malformed = approvedlist.ErrTooLarge, approvedlist.ErrMalformed
		case "criteria":
			_, got = criteria.Decode(b)
			tooLarge, malformed = criteria.ErrTooLarge, criteria.ErrMalformed
		default:
			t.Fatalf("%s: kind %q", r.Name, r.Kind)
		}
		want := map[string]error{"overCap": tooLarge, "sharedOffsets": malformed}[r.Reason]
		if want == nil || !errors.Is(got, want) {
			t.Errorf("%s: got %v, want %v", r.Name, got, want)
		}
	}
}

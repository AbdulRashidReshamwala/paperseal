package storage

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
)

// ManifestFile is one entry of manifest.json. Recipient and ShareHash are for
// files addressed to one holder.
type ManifestFile struct {
	Name      string `json:"name"`
	SHA256    string `json:"sha256"`
	Recipient string `json:"recipient,omitempty"`
	ShareHash string `json:"shareHash,omitempty"`
}

// Manifest is manifest.json: {"examId": hex, "files": [...]}, sorted by name.
type Manifest struct {
	ExamID string         `json:"examId"`
	Files  []ManifestFile `json:"files"`
}

// ManifestName is the manifest's file name inside the exam folder.
const ManifestName = "manifest.json"

// Hex is the 0x-prefixed lowercase hex of b, the form of every byte value in
// the manifest.
func Hex(b []byte) string { return "0x" + hex.EncodeToString(b) }

// NewManifest sorts the files by name.
func NewManifest(examID [32]byte, files []ManifestFile) Manifest {
	out := append([]ManifestFile(nil), files...)
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return Manifest{ExamID: Hex(examID[:]), Files: out}
}

// Marshal writes the manifest as compact JSON. The bytes written are the bytes
// storageManifestHash covers.
func (m Manifest) Marshal() ([]byte, error) { return json.Marshal(m) }

// Hash is the plain SHA-256 of the manifest bytes.
func Hash(manifest []byte) [32]byte { return sha256.Sum256(manifest) }

// ParseManifest reads a manifest strictly: no unknown fields and files sorted
// by name without repeats.
func ParseManifest(b []byte) (Manifest, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var m Manifest
	if err := dec.Decode(&m); err != nil {
		return Manifest{}, fmt.Errorf("storage: manifest: %w", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return Manifest{}, errors.New("storage: manifest: trailing data")
	}
	for i := 1; i < len(m.Files); i++ {
		if m.Files[i-1].Name >= m.Files[i].Name {
			return Manifest{}, errors.New("storage: manifest: files are not sorted by name")
		}
	}
	return m, nil
}

// File returns the entry with a name.
func (m Manifest) File(name string) (ManifestFile, bool) {
	for _, f := range m.Files {
		if f.Name == name {
			return f, true
		}
	}
	return ManifestFile{}, false
}

// Prefix is the folder of one exam in storage: "<examId>/", with the exam ID as
// 0x-prefixed lowercase hex.
func Prefix(examID [32]byte) string { return Hex(examID[:]) + "/" }

// Package build selects questions and assembles the one encrypted paper.
package build

import (
	"context"

	"paperseal/tee/internal/criteria"
	"paperseal/tee/internal/notimpl"
)

// Paper is the output of Build, and supplies its fields of hashing.BuildFields.
// The caller adds the rest once the files are stored, because
// storageManifestHash isn't known here. K stays in memory only long enough to
// split.
type Paper struct {
	EncryptedPaper  []byte   // The paper and seed, encrypted with K.
	PaperHash       [32]byte // Plain SHA-256 of EncryptedPaper.
	SaltedPaperHash [32]byte // hashing.SaltedPaper over the seed and paper.
	Selected        uint32
	BankSize        uint32
	K               []byte
}

// Builder runs Build after Lock. It generates the private seed itself, so the
// seed that picks the questions never comes from outside the TEE.
type Builder interface {
	Build(ctx context.Context, c criteria.Criteria) (Paper, error)
}

// Selector is the stub Builder.
type Selector struct{}

// Build is not implemented.
func (Selector) Build(context.Context, criteria.Criteria) (Paper, error) {
	return Paper{}, notimpl.New("build.Selector.Build")
}

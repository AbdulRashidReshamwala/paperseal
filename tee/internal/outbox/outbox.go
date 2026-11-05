// Package outbox holds the TEE-signed Build for the board to post. It is the
// TEE's only way to write to the chain: the TEE has no wallet, and the board app
// sends the message from its own address. The board posts the approved list
// itself, and Lock posts nothing.
package outbox

import (
	"context"

	"paperseal/tee/internal/notimpl"
)

// Kind names the ExamRegistry function that takes the message.
type Kind string

// KindBuild is the only TEE message that goes on-chain.
const KindBuild Kind = "postBuild"

// Message is one write, with the fields of hashing.BuildFields. ExamRegistry
// doesn't verify the signature, so apps verify it against the attestation token.
type Message struct {
	Kind                Kind
	ExamID              [32]byte
	ApprovedListHash    [32]byte
	PaperHash           [32]byte
	StorageManifestHash [32]byte
	SaltedPaperHash     [32]byte
	Selected            uint32
	BankSize            uint32
	CriteriaHash        [32]byte
	TEESignature        [64]byte
	InstancePublicKey   []byte
}

// Queue keeps messages until the board collects them.
type Queue interface {
	Put(ctx context.Context, m Message) error
	List(ctx context.Context) ([]Message, error)
}

// Memory is the stub Queue.
type Memory struct{}

// Put is not implemented.
func (Memory) Put(context.Context, Message) error { return notimpl.New("outbox.Memory.Put") }

// List is not implemented.
func (Memory) List(context.Context) ([]Message, error) { return nil, notimpl.New("outbox.Memory.List") }

// Package outbox holds the TEE-signed Build for the board to post. It is the
// TEE's only way to write to the chain: the TEE has no wallet, and the board app
// sends the message from its own address. The board posts the approved list
// itself, and Lock posts nothing.
package outbox

import (
	"context"
	"errors"
	"sync"
)

// Kind names the message. The Build is the only one.
type Kind string

// KindBuild is the only TEE message that goes on-chain.
const KindBuild Kind = "build"

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

// ErrAlreadyQueued is returned for a second Build, because ExamRegistry accepts
// one per exam.
var ErrAlreadyQueued = errors.New("outbox: a Build is already queued")

// Queue keeps messages until the board collects them.
type Queue interface {
	Put(ctx context.Context, m Message) error
	List(ctx context.Context) ([]Message, error)
}

// Memory is the Queue. The TEE keeps no long-term state, so a stopped instance
// loses it, and the board starts a new one.
type Memory struct {
	mu   sync.Mutex
	msgs []Message
}

var _ Queue = (*Memory)(nil)

// Put queues a message. The Build is accepted once.
func (q *Memory) Put(_ context.Context, m Message) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, have := range q.msgs {
		if have.Kind == m.Kind {
			return ErrAlreadyQueued
		}
	}
	m.InstancePublicKey = append([]byte(nil), m.InstancePublicKey...)
	q.msgs = append(q.msgs, m)
	return nil
}

// List returns the queued messages.
func (q *Memory) List(context.Context) ([]Message, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return append([]Message(nil), q.msgs...), nil
}

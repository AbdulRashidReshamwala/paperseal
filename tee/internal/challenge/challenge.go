// Package challenge issues the fresh TEE challenges in spec/api.md "Passkey
// Signatures". A challenge is 32 random bytes plus an expiry, authenticated
// with HMAC-SHA256 under a key that lives only in memory, so issuing one stores
// nothing and anyone asking for challenges can't fill memory. Only consumed
// challenges are remembered, in a bounded set, until they would have expired.
// Each route that takes a challenge has its own Store and its own key, so a
// challenge issued for one purpose can't be spent on another.
//
// Callers should Check a challenge first, verify the signature over it, and
// Consume it last, so only requests that carry a valid signature can use up
// room in the spent set.
package challenge

import (
	"container/heap"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"sync"
	"time"
)

// NonceSize is the random part of a challenge.
const NonceSize = 32

// Size is the length of a challenge on the wire: the nonce, the expiry as
// big-endian Unix milliseconds, and the 32-byte HMAC-SHA256 tag.
const Size = NonceSize + 8 + sha256.Size

// TTL is how long a challenge stays valid.
const TTL = 5 * time.Minute

// maxSpent bounds memory for the consumed challenges.
const maxSpent = 100000

// Errors a caller can map to a response.
var (
	ErrUnknown = errors.New("challenge: unknown or already used")
	ErrExpired = errors.New("challenge: expired")
	ErrBusy    = errors.New("challenge: too many recently used challenges")
)

type spentEntry struct {
	nonce   [NonceSize]byte
	expires time.Time
}

// expiryHeap orders spent entries by expiry, so eviction takes the oldest.
type expiryHeap []spentEntry

func (h expiryHeap) Len() int           { return len(h) }
func (h expiryHeap) Less(i, j int) bool { return h[i].expires.Before(h[j].expires) }
func (h expiryHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *expiryHeap) Push(x any)        { *h = append(*h, x.(spentEntry)) }
func (h *expiryHeap) Pop() any {
	old := *h
	n := len(old)
	e := old[n-1]
	*h = old[:n-1]
	return e
}

// Store issues and spends challenges.
type Store struct {
	now func() time.Time
	key [32]byte

	mu    sync.Mutex
	spent map[[NonceSize]byte]time.Time
	order expiryHeap
}

// New returns a Store. A nil now uses the system clock. The clock only expires
// challenges, which are not a security claim about time, so drand isn't needed.
func New(now func() time.Time) *Store {
	if now == nil {
		now = time.Now
	}
	s := &Store{now: now, spent: map[[NonceSize]byte]time.Time{}}
	if _, err := rand.Read(s.key[:]); err != nil {
		panic("challenge: no randomness: " + err.Error())
	}
	return s
}

func (s *Store) tag(body []byte) []byte {
	m := hmac.New(sha256.New, s.key[:])
	m.Write(body)
	return m.Sum(nil)
}

// Issue returns a new challenge. It keeps nothing.
func (s *Store) Issue() ([]byte, error) {
	c := make([]byte, NonceSize+8, Size)
	if _, err := rand.Read(c[:NonceSize]); err != nil {
		return nil, err
	}
	binary.BigEndian.PutUint64(c[NonceSize:], uint64(s.now().Add(TTL).UnixMilli()))
	return append(c, s.tag(c)...), nil
}

// parse checks the tag and returns the nonce and expiry. A challenge that
// this Store didn't issue is ErrUnknown.
func (s *Store) parse(c []byte) (nonce [NonceSize]byte, expires time.Time, err error) {
	if len(c) != Size || !hmac.Equal(c[NonceSize+8:], s.tag(c[:NonceSize+8])) {
		return nonce, expires, ErrUnknown
	}
	copy(nonce[:], c)
	expires = time.UnixMilli(int64(binary.BigEndian.Uint64(c[NonceSize:])))
	return nonce, expires, nil
}

// Check says whether a challenge is genuine, unexpired and unspent, without
// spending it.
func (s *Store) Check(c []byte) error {
	nonce, expires, err := s.parse(c)
	if err != nil {
		return err
	}
	if !s.now().Before(expires) {
		return ErrExpired
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, used := s.spent[nonce]; used {
		return ErrUnknown
	}
	return nil
}

// evict drops spent entries whose challenges have expired, because an expired
// challenge is refused anyway. mu is held.
func (s *Store) evict(now time.Time) {
	for len(s.order) > 0 && !now.Before(s.order[0].expires) {
		e := heap.Pop(&s.order).(spentEntry)
		delete(s.spent, e.nonce)
	}
}

// Consume spends a challenge. A second Consume of the same challenge is
// ErrUnknown. When the spent set is full of unexpired entries it refuses with
// ErrBusy rather than forget one, so a challenge is never accepted twice.
func (s *Store) Consume(c []byte) error {
	nonce, expires, err := s.parse(c)
	if err != nil {
		return err
	}
	now := s.now()
	if !now.Before(expires) {
		return ErrExpired
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.evict(now)
	if _, used := s.spent[nonce]; used {
		return ErrUnknown
	}
	if len(s.spent) >= maxSpent {
		return ErrBusy
	}
	s.spent[nonce] = expires
	heap.Push(&s.order, spentEntry{nonce, expires})
	return nil
}

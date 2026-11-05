// Package approvedlist encodes and decodes the `entries` bytes in spec/api.md
// "Approved List", which are abi.encode(Entry[]). The bytes come from the chain
// and the board wrote them, so Decode trusts nothing and accepts one encoding
// only. go-ethereum reads and writes the bytes, so none of that is by hand here.
package approvedlist

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/ethereum/go-ethereum/accounts/abi"

	"paperseal/tee/internal/abilayout"
	"paperseal/tee/internal/hashing"
	"paperseal/tee/internal/spec"
)

// Role is the `role` byte of an entry. It is an alias because the ABI decoder
// can only copy a uint8 into a plain uint8.
type Role = uint8

const (
	RoleSetter       Role = 1 // Has no derived key.
	RoleNeutral      Role = 2 // A neutral party, a key holder.
	RoleCentreHolder Role = 3 // A centre that is a key holder.
	RoleCentre       Role = 4 // An approved centre without a share.
)

// Reasons Decode refuses a list. Wrapped errors add where and why.
var (
	ErrMalformed          = errors.New("approvedlist: not a valid abi.encode(Entry[])")
	ErrNonCanonical       = errors.New("approvedlist: bytes differ from the canonical encoding")
	ErrUnknownRole        = errors.New("approvedlist: unknown role")
	ErrPasskey            = errors.New("approvedlist: bad passkey public key")
	ErrDerivedKey         = errors.New("approvedlist: bad derived public key for the role")
	ErrOwner              = errors.New("approvedlist: owner must be non-blank UTF-8")
	ErrSetterOwner        = errors.New("approvedlist: a setter's owner must be the 0x hex of the setterOwner hash of its own passkey")
	ErrRepeatedPasskey    = errors.New("approvedlist: repeated passkey")
	ErrRepeatedDerivedKey = errors.New("approvedlist: repeated derived key")
	ErrHolderCount        = errors.New("approvedlist: wrong number of key holders")
	ErrTooLarge           = errors.New("approvedlist: entries exceed limits.entriesBytes")
	ErrLimit              = errors.New("approvedlist: over a limit in spec limits")
)

// listArgs is the ABI shape of `entries`: one Entry[] argument.
var listArgs = func() abi.Arguments {
	t, err := abi.NewType("tuple[]", "", []abi.ArgumentMarshaling{
		{Name: "role", Type: "uint8"},
		{Name: "passkeyPublicKey", Type: "bytes"},
		{Name: "derivedPublicKey", Type: "bytes"},
		{Name: "owner", Type: "string"},
	})
	if err != nil {
		panic("approvedlist: " + err.Error())
	}
	return abi.Arguments{{Type: t}}
}()

// Entry is one person or centre on the list.
type Entry struct {
	Role             Role
	PasskeyPublicKey []byte
	DerivedPublicKey []byte // Empty for setters, a public key for every other role.
	Owner            string
}

func (e Entry) check() error {
	if e.Role < RoleSetter || e.Role > RoleCentre {
		return fmt.Errorf("%w: %d", ErrUnknownRole, e.Role)
	}
	if err := hashing.CheckPublicKey(e.PasskeyPublicKey); err != nil {
		return fmt.Errorf("%w: %v", ErrPasskey, err)
	}
	if e.Role == RoleSetter {
		if len(e.DerivedPublicKey) != 0 {
			return fmt.Errorf("%w: a setter has none", ErrDerivedKey)
		}
	} else if err := hashing.CheckPublicKey(e.DerivedPublicKey); err != nil {
		return fmt.Errorf("%w: %v", ErrDerivedKey, err)
	}
	if strings.TrimSpace(e.Owner) == "" || !utf8.ValidString(e.Owner) {
		return ErrOwner
	}
	// A setter's name is never published. Its owner is the setterOwner hash of
	// its own passkey, which every reader recomputes.
	if e.Role == RoleSetter {
		m, err := hashing.SetterOwner(e.PasskeyPublicKey)
		if err != nil {
			return fmt.Errorf("%w: %v", ErrPasskey, err)
		}
		sum := m.Sum()
		if e.Owner != "0x"+hex.EncodeToString(sum[:]) {
			return fmt.Errorf("%w: %q is not the setterOwner hash of its own passkey", ErrSetterOwner, e.Owner)
		}
	}
	return nil
}

// Encode writes entries in the given order, because the hash covers the posted
// bytes and order is free. It checks each entry but not the list rules, so it
// can write the partial lists that test vectors need. Only Decode decides
// whether a list is acceptable.
func Encode(entries []Entry) ([]byte, error) {
	for i, e := range entries {
		if err := e.check(); err != nil {
			return nil, fmt.Errorf("entry %d: %w", i, err)
		}
	}
	return pack(entries)
}

// checkLayout walks the offsets of abi.encode(Entry[]) from the raw bytes and
// allocates nothing. Every element and each of its three values must have bytes
// of its own, so no input decodes to more than its own length.
func checkLayout(b []byte) error {
	top, err := abilayout.Word(b, 0)
	if err != nil {
		return err
	}
	if top != 32 {
		return fmt.Errorf("%w: array offset %d, want 32", abilayout.ErrLayout, top)
	}
	_, _, err = abilayout.Array(b, 32, len(b), func(start, limit int) (int, error) {
		const head = 4 * 32 // role, then the offsets of three values.
		if limit-start < head {
			return 0, fmt.Errorf("%w: entry is shorter than its head", abilayout.ErrLayout)
		}
		pos := head
		end := start + head
		for i := range 3 {
			off, err := abilayout.Word(b, start+32*(i+1))
			if err != nil {
				return 0, err
			}
			// Each value starts at or after the end of the one before it, and
			// the first right after the head.
			if off < uint64(pos) || off > uint64(limit-start) || (i == 0 && off != head) {
				return 0, fmt.Errorf("%w: value %d offset %d is out of place", abilayout.ErrLayout, i, off)
			}
			if end, err = abilayout.Bytes(b, start+int(off), limit); err != nil {
				return 0, err
			}
			pos = end - start
		}
		return end, nil
	})
	return err
}

// checkLimits applies the spec's limits to a decoded list.
func checkLimits(entries []Entry) error {
	lim := spec.C.Limits
	if len(entries) > lim.Entries {
		return fmt.Errorf("%w: %d entries, at most %d", ErrLimit, len(entries), lim.Entries)
	}
	for i, e := range entries {
		if len(e.Owner) > lim.OwnerBytes {
			return fmt.Errorf("entry %d: %w: owner is %d bytes, at most %d", i, ErrLimit, len(e.Owner), lim.OwnerBytes)
		}
	}
	return nil
}

// Decode parses entries and applies every list rule that needs only the list
// itself. Before decoding it refuses bytes over limits.entriesBytes and bytes
// whose offsets share or overlap values, which keeps what the decoder builds
// proportional to the input. ABI decoding tolerates trailing bytes, gaps, shared offsets and dirty
// padding, so it re-encodes what it read and refuses any difference: one list
// has one encoding. The caller must still run CheckRegistered.
func Decode(b []byte) ([]Entry, error) {
	if len(b) > spec.C.Limits.EntriesBytes {
		return nil, fmt.Errorf("%w: %d bytes, at most %d", ErrTooLarge, len(b), spec.C.Limits.EntriesBytes)
	}
	if err := checkLayout(b); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	values, err := listArgs.Unpack(b)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	var entries []Entry
	if err := listArgs.Copy(&entries, values); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	if err := checkLimits(entries); err != nil {
		return nil, err
	}
	again, err := pack(entries)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	if !bytes.Equal(again, b) {
		return nil, ErrNonCanonical
	}
	for i := range entries {
		// The decoder's byte slices alias b.
		entries[i].PasskeyPublicKey = bytes.Clone(entries[i].PasskeyPublicKey)
		entries[i].DerivedPublicKey = bytes.Clone(entries[i].DerivedPublicKey)
		if err := entries[i].check(); err != nil {
			return nil, fmt.Errorf("entry %d: %w", i, err)
		}
	}
	if err := checkList(entries); err != nil {
		return nil, err
	}
	return entries, nil
}

func pack(entries []Entry) ([]byte, error) { return listArgs.Pack(entries) }

// Registrations answers whether the TEE verified a registration at Onboard.
type Registrations interface {
	// Verified reports whether a registration with exactly these values passed
	// the passkey signature check. derivedPublicKey is empty for a setter.
	Verified(passkeyPublicKey, derivedPublicKey []byte, owner string) bool
}

// ErrNotRegistered is returned for an entry the TEE didn't verify.
var ErrNotRegistered = errors.New("approvedlist: entry was not verified at registration")

// CheckRegistered rejects the list if any entry wasn't verified at
// registration, with the same passkey, derived key and owner. A setter must
// have registered without a derived key, because role follows from the key.
// It applies at Onboard alone: only the instance that ran Onboard holds
// registrations.
func CheckRegistered(entries []Entry, registered Registrations) error {
	for i, e := range entries {
		if !registered.Verified(e.PasskeyPublicKey, e.DerivedPublicKey, e.Owner) {
			return fmt.Errorf("entry %d (%s): %w", i, e.Owner, ErrNotRegistered)
		}
	}
	return nil
}

func checkList(entries []Entry) error {
	passkeys := make(map[string]bool, len(entries))
	derived := make(map[string]bool, len(entries))
	neutrals, centres := 0, 0
	for i, e := range entries {
		if passkeys[string(e.PasskeyPublicKey)] {
			return fmt.Errorf("entry %d: %w", i, ErrRepeatedPasskey)
		}
		passkeys[string(e.PasskeyPublicKey)] = true
		// Setters all have the same empty key.
		if len(e.DerivedPublicKey) != 0 {
			if derived[string(e.DerivedPublicKey)] {
				return fmt.Errorf("entry %d: %w", i, ErrRepeatedDerivedKey)
			}
			derived[string(e.DerivedPublicKey)] = true
		}
		switch e.Role {
		case RoleNeutral:
			neutrals++
		case RoleCentreHolder:
			centres++
		}
	}
	t := spec.C.Threshold
	if neutrals != t.Neutrals || centres != t.Centres {
		return fmt.Errorf("%w: %d neutrals and %d centres, need %d and %d",
			ErrHolderCount, neutrals, centres, t.Neutrals, t.Centres)
	}
	return nil
}

package chainread

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"paperseal/tee/internal/spec"
)

// BoardFromCode checks deployed code against the pin in spec/registry.json, as
// "Registry Code" in spec/api.md sets out, and returns the board written into
// it. The metadata solc appends is left out, so a comment edit doesn't change
// the result. A failure wraps ErrWrongRegistry.
func BoardFromCode(code []byte) ([20]byte, error) {
	var board [20]byte
	if len(code) < 2 {
		return board, fmt.Errorf("%w: code is %d bytes", ErrWrongRegistry, len(code))
	}
	metadata := int(code[len(code)-2])<<8 + int(code[len(code)-1]) + 2
	if metadata > len(code) {
		return board, fmt.Errorf("%w: code declares %d bytes of metadata", ErrWrongRegistry, metadata)
	}
	executable := bytes.Clone(code[:len(code)-metadata])
	pin := spec.R
	if len(executable) != pin.ExecutableBytes {
		return board, fmt.Errorf("%w: %d bytes of code, want %d", ErrWrongRegistry, len(executable), pin.ExecutableBytes)
	}
	word := make([]byte, 32)
	copy(word, executable[pin.BoardOffsets[0]:])
	for _, offset := range pin.BoardOffsets {
		if !bytes.Equal(executable[offset:offset+32], word) {
			return board, fmt.Errorf("%w: its board words differ", ErrWrongRegistry)
		}
		clear(executable[offset : offset+32])
	}
	copy(board[:], word[12:])
	if !bytes.Equal(word[:12], make([]byte, 12)) || board == ([20]byte{}) {
		return [20]byte{}, fmt.Errorf("%w: its board word is not an address", ErrWrongRegistry)
	}
	sum := sha256.Sum256(executable)
	if got := "0x" + hex.EncodeToString(sum[:]); got != pin.RuntimeCodeHash {
		return [20]byte{}, fmt.Errorf("%w: code hash %s, want %s", ErrWrongRegistry, got, pin.RuntimeCodeHash)
	}
	return board, nil
}

// checkRegistry confirms the attested address runs ExamRegistry, before any read
// from it is trusted, and remembers that once it holds. Code can't change after
// deployment, so one good read is enough.
//
// Only code that differs is ErrWrongRegistry. No code at all is a plain error:
// at chain.readBlock finalized a new contract isn't visible for about 15
// minutes, and a lagging node also answers this way. Nothing from the address is
// trusted meanwhile, so waiting is safe.
func (r *RPC) checkRegistry(ctx context.Context) error {
	r.mu.Lock()
	ok := r.registryOK
	r.mu.Unlock()
	if ok {
		return nil
	}
	raw, err := r.call(ctx, "eth_getCode", r.registryHex(), r.readBlock)
	if err != nil {
		return err
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return fmt.Errorf("chainread: eth_getCode: result: %w", err)
	}
	digits, found := strings.CutPrefix(s, "0x")
	if !found {
		return errors.New("chainread: eth_getCode: result is not hex")
	}
	code, err := hex.DecodeString(digits)
	if err != nil {
		return errors.New("chainread: eth_getCode: result is not hex")
	}
	if len(code) == 0 {
		return fmt.Errorf("chainread: no code at %s at block %s yet", r.registryHex(), r.readBlock)
	}
	board, err := BoardFromCode(code)
	if err != nil {
		return err
	}
	slog.Info("registry code matches the pin", "registry", r.registryHex(), "board", "0x"+hex.EncodeToString(board[:]))
	r.mu.Lock()
	r.registryOK = true
	r.mu.Unlock()
	return nil
}

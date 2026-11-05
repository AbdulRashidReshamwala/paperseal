// Package settings parses the attested exam settings. They reach the workload
// as arguments through Confidential Space tee-cmd, and the attestation token
// exposes those arguments, so parsing is strict: one exact list of arguments.
package settings

import (
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"paperseal/tee/internal/spec"
)

// Exam holds the "Exam Settings" fields in spec/api.md. The commitHash and
// imageDigest that createExam also stores are not startup arguments.
type Exam struct {
	ExamID       [32]byte
	ExamStart    uint64 // T, in Unix seconds.
	Delta        uint64 // Δ, in seconds.
	LockRound    uint64
	UnlockRound  uint64
	EndRound     uint64
	CriteriaHash [32]byte
	RPCHost      string
	Registry     [20]byte
	ChainID      uint64
}

// Parse reads the settings and applies the same checks as
// ExamRegistry.createExam, so a TEE can't start with settings the contract would
// refuse. Arguments are one --name=value each, in the order of the table in
// spec/api.md, so the attestation check can compare one exact list.
func Parse(args []string) (Exam, error) {
	var e Exam
	number := func(dst *uint64) func(string) error {
		return func(v string) error { return parseUint64(v, dst) }
	}
	fixed := func(dst []byte) func(string) error {
		return func(v string) error { return parseFixed(v, dst) }
	}
	fields := []struct {
		name  string
		parse func(string) error
	}{
		{"exam-id", fixed(e.ExamID[:])},
		{"exam-start", number(&e.ExamStart)},
		{"delta", number(&e.Delta)},
		{"lock-round", number(&e.LockRound)},
		{"unlock-round", number(&e.UnlockRound)},
		{"end-round", number(&e.EndRound)},
		{"criteria-hash", fixed(e.CriteriaHash[:])},
		{"rpc-host", func(v string) error {
			if err := checkHostname(v); err != nil {
				return err
			}
			e.RPCHost = v
			return nil
		}},
		{"registry", fixed(e.Registry[:])},
		{"chain-id", number(&e.ChainID)},
	}
	for i, f := range fields {
		if i >= len(args) {
			return Exam{}, fmt.Errorf("settings: missing --%s", f.name)
		}
		v, ok := strings.CutPrefix(args[i], "--"+f.name+"=")
		if !ok {
			return Exam{}, fmt.Errorf("settings: argument %d must be --%s=<value>, got %q", i+1, f.name, args[i])
		}
		if err := f.parse(v); err != nil {
			return Exam{}, fmt.Errorf("settings: --%s: %w", f.name, err)
		}
	}
	if len(args) > len(fields) {
		return Exam{}, fmt.Errorf("settings: unexpected argument %q", args[len(fields)])
	}
	if err := e.validate(); err != nil {
		return Exam{}, err
	}
	return e, nil
}

func (e Exam) validate() error {
	if e.ExamID == ([32]byte{}) {
		return errors.New("settings: exam ID is zero")
	}
	if e.CriteriaHash == ([32]byte{}) {
		return errors.New("settings: criteria hash is zero")
	}
	if e.Registry == ([20]byte{}) {
		return errors.New("settings: registry address is zero")
	}
	if want := uint64(spec.C.Chain.ChainID); e.ChainID != want {
		return fmt.Errorf("settings: chain ID must be %d, got %d", want, e.ChainID)
	}
	if e.LockRound == 0 || e.UnlockRound <= e.LockRound || e.EndRound <= e.UnlockRound {
		return errors.New("settings: rounds must be non-zero and increase: lock, unlock, end")
	}
	if e.Delta == 0 {
		return errors.New("settings: delta is zero")
	}
	genesis := uint64(spec.C.Drand.GenesisTime)
	// The first test stops the subtraction in the second wrapping around.
	if e.ExamStart <= e.Delta || e.ExamStart-e.Delta <= genesis {
		return errors.New("settings: exam start minus delta must be after the drand genesis time")
	}
	if want := unlockRoundFor(e.ExamStart - e.Delta); e.UnlockRound != want {
		return fmt.Errorf("settings: unlock round must be %d, got %d", want, e.UnlockRound)
	}
	if min := firstRoundAfter(e.ExamStart); e.EndRound < min {
		return fmt.Errorf("settings: end round must be produced after exam start, so at least %d, got %d", min, e.EndRound)
	}
	return nil
}

// unlockRoundFor returns the first quicknet round at or after a time, which is
// ceil((at - genesisTime) / periodSeconds) + 1. It rounds up, so the paper
// can't open early. at must be after genesisTime.
func unlockRoundFor(at uint64) uint64 {
	elapsed := at - uint64(spec.C.Drand.GenesisTime)
	period := uint64(spec.C.Drand.PeriodSeconds)
	round := elapsed/period + 1
	if elapsed%period != 0 {
		round++
	}
	return round
}

// firstRoundAfter returns the first quicknet round produced strictly after a
// time. It works in rounds, not seconds, because the time of a large round
// would overflow a uint64. at must not be before genesisTime.
func firstRoundAfter(at uint64) uint64 {
	elapsed := at - uint64(spec.C.Drand.GenesisTime)
	return elapsed/uint64(spec.C.Drand.PeriodSeconds) + 2
}

// parseUint64 accepts only canonical decimal, so "007" can't stand in for "7".
func parseUint64(v string, dst *uint64) error {
	n, err := strconv.ParseUint(v, 10, 64)
	if err != nil {
		return errors.New("must be a decimal uint64")
	}
	if strconv.FormatUint(n, 10) != v {
		return errors.New("must be canonical decimal")
	}
	*dst = n
	return nil
}

func parseHex(v string) ([]byte, error) {
	digits, ok := strings.CutPrefix(v, "0x")
	if !ok {
		return nil, errors.New("must start with 0x")
	}
	if digits != strings.ToLower(digits) {
		return nil, errors.New("must be lowercase hex")
	}
	b, err := hex.DecodeString(digits)
	if err != nil {
		return nil, errors.New("must be hex")
	}
	return b, nil
}

// parseFixed fills dst from hex of exactly its length.
func parseFixed(v string, dst []byte) error {
	b, err := parseHex(v)
	if err != nil {
		return err
	}
	if len(b) != len(dst) {
		return fmt.Errorf("must be %d bytes, got %d", len(dst), len(b))
	}
	copy(dst, b)
	return nil
}

// checkHostname accepts lowercase letter-digit-hyphen labels only. That leaves
// no room for a scheme, port, path, credentials or IPv6 address, and it rejects
// uppercase and a trailing dot, which would be other spellings of one host.
func checkHostname(v string) error {
	if len(v) == 0 || len(v) > 253 {
		return errors.New("must be a hostname of 1 to 253 characters")
	}
	labels := strings.Split(v, ".")
	for _, label := range labels {
		if err := checkLabel(label); err != nil {
			return err
		}
	}
	// A last label that reads as a number makes the name an IPv4 address.
	if isNumeric(labels[len(labels)-1]) {
		return errors.New("must be a hostname, not an IP address")
	}
	return nil
}

// isNumeric reports whether a label is decimal or 0x-prefixed hex.
func isNumeric(label string) bool {
	digits, isHex := strings.CutPrefix(label, "0x")
	for _, c := range []byte(digits) {
		decimal := c >= '0' && c <= '9'
		if !decimal && !(isHex && c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func checkLabel(label string) error {
	if len(label) == 0 || len(label) > 63 {
		return errors.New("each hostname label must be 1 to 63 characters")
	}
	if label[0] == '-' || label[len(label)-1] == '-' {
		return errors.New("a hostname label can't start or end with a hyphen")
	}
	for _, c := range []byte(label) {
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' {
			return errors.New("must be a lowercase hostname, with no scheme, port or path")
		}
	}
	return nil
}

// Args returns the startup arguments for these settings, in the order and form
// Parse requires. The attestation check compares the token's arguments to this
// exact list.
func (e Exam) Args() []string {
	hexOf := func(b []byte) string { return "0x" + hex.EncodeToString(b) }
	dec := func(n uint64) string { return strconv.FormatUint(n, 10) }
	return []string{
		"--exam-id=" + hexOf(e.ExamID[:]),
		"--exam-start=" + dec(e.ExamStart),
		"--delta=" + dec(e.Delta),
		"--lock-round=" + dec(e.LockRound),
		"--unlock-round=" + dec(e.UnlockRound),
		"--end-round=" + dec(e.EndRound),
		"--criteria-hash=" + hexOf(e.CriteriaHash[:]),
		"--rpc-host=" + e.RPCHost,
		"--registry=" + hexOf(e.Registry[:]),
		"--chain-id=" + dec(e.ChainID),
	}
}

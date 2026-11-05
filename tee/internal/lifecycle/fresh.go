package lifecycle

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"

	"paperseal/tee/internal/approvedlist"
	"paperseal/tee/internal/attestation"
	"paperseal/tee/internal/chainread"
	"paperseal/tee/internal/hashing"
	"paperseal/tee/internal/release"
	"paperseal/tee/internal/storage"
)

// startFreshUnlock is "Unlock Instance" in spec/api.md, for an instance that
// shares no state with the one that ran Build. It trusts the on-chain Build
// only after verifying that it came from attested code, and then trusts the
// list the Build committed to. It needs no registrations, so CheckRegistered
// isn't run. If any step fails, the instance refuses every share: it fails
// rather than collecting shares it can't vouch for.
func (m *Machine) startFreshUnlock(ctx context.Context, list chainread.List, built chainread.Build) error {
	exam := m.cfg.Exam
	if m.cfg.Verifier == nil {
		return fail("unlock: no Google root to check the Build instance's token against")
	}

	// The exam record gives the image digest the token must name.
	rec, err := m.cfg.Chain.Exam(ctx)
	if err != nil {
		return m.classify(err)
	}

	// 2. The token, through the manifest the Build commits to. Storage being
	// down is retryable. A file that doesn't match its hash is not.
	prefix := storage.Prefix(exam.ExamID)
	manifestBytes, err := m.cfg.Store.Get(ctx, prefix+storage.ManifestName)
	if err != nil {
		return fmt.Errorf("unlock: manifest: %w", err)
	}
	if storage.Hash(manifestBytes) != built.StorageManifestHash {
		return fail("unlock: manifest.json does not match storageManifestHash on-chain")
	}
	manifest, err := storage.ParseManifest(manifestBytes)
	if err != nil {
		return fail("unlock: %w", err)
	}
	if manifest.ExamID != storage.Hex(exam.ExamID[:]) {
		return fail("unlock: manifest is for another exam")
	}
	tokenEntry, ok := manifest.File("token.jwt")
	if !ok {
		return fail("unlock: manifest lists no token.jwt")
	}
	token, err := m.cfg.Store.Get(ctx, prefix+"token.jwt")
	if err != nil {
		return fmt.Errorf("unlock: token: %w", err)
	}
	if sum := sha256.Sum256(token); storage.Hex(sum[:]) != tokenEntry.SHA256 {
		return fail("unlock: token.jwt does not match the manifest")
	}

	// 3. The token against Google's root and the on-chain settings. It is a
	// record, so its expiry is not checked.
	if _, err := m.cfg.Verifier.VerifyPKI(string(token), attestation.Expect{
		Exam: exam, ImageDigest: rec.ImageDigest, InstancePublicKey: built.InstancePublicKey,
	}); err != nil {
		return fail("unlock: %w", err)
	}

	// 4. The Build's signature, by the key the token binds.
	if len(built.TEESignature) != 64 {
		return fail("unlock: build signature has the wrong length")
	}
	var sig [64]byte
	copy(sig[:], built.TEESignature)
	if built.CriteriaHash != exam.CriteriaHash {
		return fail("unlock: build criteriaHash differs from the attested one")
	}
	fields := hashing.BuildFields{
		ExamID: exam.ExamID, ApprovedListHash: built.ApprovedListHash, PaperHash: built.PaperHash,
		StorageManifestHash: built.StorageManifestHash, SaltedPaperHash: built.SaltedPaperHash,
		Selected: built.Selected, BankSize: built.BankSize, CriteriaHash: built.CriteriaHash,
	}
	if err := attestation.Verify(built.InstancePublicKey, hashing.Build(fields), sig); err != nil {
		return fail("unlock: build signature: %w", err)
	}

	// 5. The list the Build committed to is the one on-chain and the one read.
	msg, err := hashing.ApprovedList(exam.ExamID, list.Entries)
	if err != nil {
		return fail("unlock: %w", err)
	}
	if h := msg.Sum(); h != built.ApprovedListHash || h != list.Hash {
		return fail("unlock: build approvedListHash differs from the on-chain list")
	}
	entries, err := approvedlist.Decode(list.Entries)
	if err != nil {
		return fail("unlock: approved list: %w", err)
	}

	// Each key holder's share hash comes from the manifest the Build covers.
	var holders []release.Holder
	var centres [][]byte
	for _, e := range entries {
		switch e.Role {
		case approvedlist.RoleNeutral, approvedlist.RoleCentreHolder:
			f, ok := manifest.File("shares/" + storage.Hex(e.DerivedPublicKey) + ".bin")
			if !ok || f.Recipient != storage.Hex(e.DerivedPublicKey) {
				return fail("unlock: manifest has no share for %s", e.Owner)
			}
			raw, err := hexDecode32(f.ShareHash)
			if err != nil {
				return fail("unlock: share hash for %s: %w", e.Owner, err)
			}
			holders = append(holders, release.Holder{PasskeyPublicKey: e.PasskeyPublicKey, ShareHash: raw})
		}
		if e.Role == approvedlist.RoleCentreHolder || e.Role == approvedlist.RoleCentre {
			centres = append(centres, e.DerivedPublicKey)
		}
	}
	if err := m.acceptList(entries, list); err != nil {
		return err
	}
	m.registrations.Close()
	m.mu.Lock()
	m.bankSize = int(built.BankSize)
	m.mu.Unlock()
	m.startUnlock(release.Facts{
		ExamID: exam.ExamID, UnlockRound: exam.UnlockRound, EndRound: exam.EndRound,
		Holders: holders, Centres: centres,
	})
	return nil
}

func hexDecode32(s string) ([32]byte, error) {
	var out [32]byte
	b, err := decodeHex(s)
	if err != nil || len(b) != 32 {
		return out, errors.New("not 32 bytes of 0x-prefixed lowercase hex")
	}
	copy(out[:], b)
	return out, nil
}

func decodeHex(s string) ([]byte, error) {
	if len(s) < 2 || s[:2] != "0x" {
		return nil, errors.New("no 0x prefix")
	}
	b, err := hex.DecodeString(s[2:])
	if err != nil || storage.Hex(b) != s {
		return nil, errors.New("not lowercase hex")
	}
	return b, nil
}

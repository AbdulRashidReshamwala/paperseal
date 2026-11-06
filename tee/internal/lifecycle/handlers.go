package lifecycle

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"time"
	"unicode/utf8"

	"paperseal/tee/internal/api"
	"paperseal/tee/internal/attestation"
	"paperseal/tee/internal/bank"
	"paperseal/tee/internal/challenge"
	"paperseal/tee/internal/hashing"
	"paperseal/tee/internal/registration"
	"paperseal/tee/internal/release"
	"paperseal/tee/internal/spec"
	"paperseal/tee/internal/timelock"
	"paperseal/tee/internal/webauthn"
)

var _ api.Backend = (*Machine)(nil)

func badRequest(code, msg string) error { return api.Errorf(http.StatusBadRequest, code, msg) }

func wrongStage(want Stage, got Stage) error {
	return api.Errorf(http.StatusConflict, "wrong_stage", "this is only accepted during "+string(want)+", and the stage is "+string(got))
}

// challengeError maps a challenge failure to a response.
func challengeError(err error) error {
	switch {
	case errors.Is(err, challenge.ErrExpired):
		return badRequest("challenge_expired", "the challenge expired, ask for a new one")
	case errors.Is(err, challenge.ErrUnknown):
		return badRequest("invalid_challenge", "the challenge is unknown or already used")
	case errors.Is(err, challenge.ErrBusy):
		return api.Errorf(http.StatusServiceUnavailable, "busy", "too many outstanding challenges")
	}
	return err
}

// Attestation implements api.Backend. Outside Confidential Space it reports the
// instance as unattested with an empty token. It never makes a token up.
func (m *Machine) Attestation(ctx context.Context) (api.AttestationResponse, error) {
	keys := m.cfg.Keys
	sig := keys.InstanceKeySignature()
	resp := api.AttestationResponse{
		InstancePublicKey: keys.PublicKey(), EncryptionPublicKey: keys.EncryptionPublicKey(),
		InstanceKeySignature: sig[:],
	}
	nonce, err := attestation.Nonce(keys.PublicKey(), m.cfg.Exam.ExamID)
	if err != nil {
		return resp, err
	}
	tok, err := m.cfg.Tokens.Token(ctx, attestation.TokenPKI, spec.C.Attestation.Audience, nonce)
	if errors.Is(err, attestation.ErrUnattested) {
		return resp, nil
	}
	if err != nil {
		return resp, api.Errorf(http.StatusBadGateway, "attestation_unavailable", "the launcher could not issue a token")
	}
	resp.Token, resp.Attested = tok.Raw, true
	return resp, nil
}

// Status implements api.Backend. It reads the machine's state under mu and
// then asks the collector with no lock held, so a slow delivery can't hold up
// every other request that needs mu.
func (m *Machine) Status(context.Context) (api.StatusResponse, error) {
	m.mu.RLock()
	resp := api.StatusResponse{
		Stage: string(m.stage), QuestionCount: m.bankSize,
		Release: api.ReleaseStatus{Released: []api.Hex{}, Required: spec.C.Threshold.Required},
	}
	stage := m.stage
	if m.list != nil {
		resp.ApprovedList = &api.ApprovedListStatus{
			ExamID: m.cfg.Exam.ExamID[:], Entries: m.list.raw, Hash: m.list.hash[:], TEESignature: m.list.signature[:],
		}
	}
	collector := m.collector
	m.mu.RUnlock()
	if stage == StageSubmit || stage == StageOnboard {
		resp.QuestionCount = m.bank.Count()
	}
	if collector != nil {
		p := collector.Progress()
		for _, k := range p.Released {
			resp.Release.Released = append(resp.Release.Released, k)
		}
	}
	return resp, nil
}

// RegisterChallenge implements api.Backend.
func (m *Machine) RegisterChallenge(context.Context) (api.ChallengeResponse, error) {
	if s := m.Stage(); s != StageOnboard {
		return api.ChallengeResponse{}, wrongStage(StageOnboard, s)
	}
	c, err := m.registerChallenges.Issue()
	if err != nil {
		return api.ChallengeResponse{}, challengeError(err)
	}
	return api.ChallengeResponse{Challenge: c}, nil
}

// Register implements api.Backend. The passkey signature covers the
// registration message. The attestation chain check is skipped while
// webauthn.requireHardwareAttestation is false, and refuses when it is true.
// inviteTag is only checked for shape. The TEE never sees the invite secret, so
// the board's app is what matches a tag to an invite.
func (m *Machine) Register(_ context.Context, req api.RegisterRequest) error {
	if s := m.Stage(); s != StageOnboard {
		return wrongStage(StageOnboard, s)
	}
	// The owner goes on the public list, so it has the list's bound.
	if maxOwner := spec.C.Limits.OwnerBytes; req.Owner == "" || len(req.Owner) > maxOwner || !utf8.ValidString(req.Owner) {
		return badRequest("invalid_owner", fmt.Sprintf("owner must be 1 to %d bytes of UTF-8", maxOwner))
	}
	if err := hashing.CheckPublicKey(req.PasskeyPublicKey); err != nil {
		return badRequest("invalid_key", "passkeyPublicKey: "+err.Error())
	}
	if len(req.InviteTag) != 32 {
		return badRequest("invalid_invite_tag", "inviteTag must be 32 bytes")
	}
	inviteTag := [32]byte(req.InviteTag)
	msg, err := hashing.Registration(req.DerivedPublicKey, []byte(req.Owner), req.Challenge, inviteTag)
	if err != nil {
		return badRequest("invalid_key", "derivedPublicKey: "+err.Error())
	}
	// Check first and Consume only after the signature verifies, so a request
	// that can't sign can't use up the room for spent challenges.
	if err := m.registerChallenges.Check(req.Challenge); err != nil {
		return challengeError(err)
	}
	err = webauthn.Verify(req.PasskeyPublicKey, webauthn.TypeGet, msg, webauthn.Assertion{
		AuthenticatorData: req.AuthenticatorData, ClientDataJSON: req.ClientDataJSON, Signature: req.Signature,
	})
	if err != nil {
		return badRequest("invalid_signature", err.Error())
	}
	if err := m.registerChallenges.Consume(req.Challenge); err != nil {
		return challengeError(err)
	}
	if _, err := webauthn.CheckAttestation(req.AttestationObject); err != nil {
		return err
	}
	err = m.registrations.Add(registration.Record{
		Owner: req.Owner, PasskeyPublicKey: req.PasskeyPublicKey, DerivedPublicKey: req.DerivedPublicKey, InviteTag: inviteTag,
	})
	switch {
	case errors.Is(err, registration.ErrDuplicate):
		return api.Errorf(http.StatusConflict, "already_registered", "this passkey or derived key is already registered")
	case errors.Is(err, registration.ErrClosed):
		// The stage can still be onboard here, on an instance waiting for the Build.
		return api.Errorf(http.StatusConflict, "wrong_stage", "registration is closed, because the approved list has been read")
	}
	return err
}

// Registrations implements api.Backend. It lists what this instance verified at
// Onboard, which is public because the approved list is. An instance that
// verified none, such as a fresh Unlock instance, returns an empty list.
func (m *Machine) Registrations(context.Context) (api.RegistrationsResponse, error) {
	out := api.RegistrationsResponse{Registrations: []api.Registration{}}
	for _, r := range m.registrations.List() {
		out.Registrations = append(out.Registrations, api.Registration{
			Owner: r.Owner, PasskeyPublicKey: r.PasskeyPublicKey, DerivedPublicKey: r.DerivedPublicKey, InviteTag: r.InviteTag[:],
		})
	}
	return out, nil
}

// QuestionChallenge implements api.Backend.
func (m *Machine) QuestionChallenge(context.Context) (api.ChallengeResponse, error) {
	c, err := m.questionChallenges.Issue()
	if err != nil {
		return api.ChallengeResponse{}, challengeError(err)
	}
	return api.ChallengeResponse{Challenge: c}, nil
}

// submitOpen reports whether questions are still accepted: the stage is
// Submit and drand hasn't published the lock round. It asks drand at most once
// a second, because every question would otherwise cost a network call.
func (m *Machine) submitOpen(ctx context.Context) error {
	if s := m.Stage(); s != StageSubmit {
		return wrongStage(StageSubmit, s)
	}
	m.mu.RLock()
	last := m.lockCached
	m.mu.RUnlock()
	if !last.IsZero() && m.now().Sub(last) < time.Second {
		return nil
	}
	_, err := m.cfg.Beacon.Randomness(ctx, m.cfg.Exam.LockRound)
	if errors.Is(err, timelock.ErrNotPublished) {
		m.mu.Lock()
		m.lockCached = m.now()
		m.mu.Unlock()
		return nil
	}
	if errors.Is(err, timelock.ErrUnavailable) {
		return releaseError(err)
	}
	if err != nil {
		return err
	}
	return api.Errorf(http.StatusConflict, "lock_round_passed", "the lock round is published, so no more questions are accepted")
}

// Questions implements api.Backend.
func (m *Machine) Questions(ctx context.Context, req api.QuestionRequest) (api.QuestionResponse, error) {
	if err := m.submitOpen(ctx); err != nil {
		return api.QuestionResponse{}, err
	}
	if err := hashing.CheckPublicKey(req.PasskeyPublicKey); err != nil {
		return api.QuestionResponse{}, badRequest("invalid_key", "passkeyPublicKey: "+err.Error())
	}
	m.mu.RLock()
	isSetter := m.setters[string(req.PasskeyPublicKey)]
	c := m.criteria
	m.mu.RUnlock()
	if !isSetter {
		return api.QuestionResponse{}, api.Errorf(http.StatusForbidden, "not_on_list", "this passkey is not a setter on the approved list")
	}
	if len(req.Ciphertext) == 0 {
		return api.QuestionResponse{}, badRequest("invalid_request", "ciphertext is empty")
	}
	hash := sha256.Sum256(req.Ciphertext)
	msg, err := hashing.QuestionSubmission(m.cfg.Exam.ExamID, req.Challenge, hash)
	if err != nil {
		return api.QuestionResponse{}, err
	}
	// Check first and Consume only after the signature verifies, so a request
	// that can't sign can't use up the room for spent challenges.
	if err := m.questionChallenges.Check(req.Challenge); err != nil {
		return api.QuestionResponse{}, challengeError(err)
	}
	err = webauthn.Verify(req.PasskeyPublicKey, webauthn.TypeGet, msg, webauthn.Assertion{
		AuthenticatorData: req.AuthenticatorData, ClientDataJSON: req.ClientDataJSON, Signature: req.Signature,
	})
	if err != nil {
		return api.QuestionResponse{}, badRequest("invalid_signature", err.Error())
	}
	if err := m.questionChallenges.Consume(req.Challenge); err != nil {
		return api.QuestionResponse{}, challengeError(err)
	}
	// The aad binds the ciphertext to its setter, so another setter can't
	// resubmit it.
	padded, err := m.cfg.Keys.OpenQuestion(req.PasskeyPublicKey, req.Ciphertext)
	if err != nil {
		return api.QuestionResponse{}, badRequest("decryption_failed", "the question did not decrypt")
	}
	defer wipe(padded) // The text below is a copy.
	topic, text, options, err := bank.Parse(padded, *c)
	switch {
	case errors.Is(err, bank.ErrUnknownTopic):
		return api.QuestionResponse{}, badRequest("unknown_topic", err.Error())
	case err != nil:
		return api.QuestionResponse{}, badRequest("invalid_question", err.Error())
	}
	err = m.bank.Add(bank.Question{Passkey: req.PasskeyPublicKey, Topic: topic, Text: text, Options: options, Hash: hash})
	switch {
	case errors.Is(err, bank.ErrDuplicate):
		return api.QuestionResponse{}, api.Errorf(http.StatusConflict, "duplicate_question", "this question is already in the bank")
	case errors.Is(err, bank.ErrClosed):
		return api.QuestionResponse{}, wrongStage(StageSubmit, m.Stage())
	case errors.Is(err, bank.ErrFull):
		return api.QuestionResponse{}, api.Errorf(http.StatusInsufficientStorage, "bank_full", "the bank is full")
	case err != nil:
		return api.QuestionResponse{}, err
	}
	receipt, err := hashing.QuestionReceipt(m.cfg.Exam.ExamID, req.PasskeyPublicKey, hash)
	if err != nil {
		return api.QuestionResponse{}, err
	}
	sig, err := m.cfg.Keys.Sign(receipt)
	if err != nil {
		return api.QuestionResponse{}, err
	}
	return api.QuestionResponse{QuestionHash: hash[:], TEESignature: sig[:]}, nil
}

// Outbox implements api.Backend.
func (m *Machine) Outbox(ctx context.Context) (api.OutboxResponse, error) {
	msgs, err := m.outbox.List(ctx)
	if err != nil {
		return api.OutboxResponse{}, err
	}
	out := api.OutboxResponse{Messages: []api.OutboxMessage{}}
	for _, msg := range msgs {
		out.Messages = append(out.Messages, api.OutboxMessage{
			Kind: string(msg.Kind), ExamID: msg.ExamID[:],
			Fields: api.BuildFields{
				ApprovedListHash: msg.ApprovedListHash[:], PaperHash: msg.PaperHash[:],
				StorageManifestHash: msg.StorageManifestHash[:], SaltedPaperHash: msg.SaltedPaperHash[:],
				Selected: msg.Selected, BankSize: msg.BankSize, CriteriaHash: msg.CriteriaHash[:],
			},
			TEESignature: msg.TEESignature[:], InstancePublicKey: msg.InstancePublicKey,
		})
	}
	return out, nil
}

// unlockCollector returns the collector only while the stage is Unlock. A
// failed instance has wiped its secrets and takes no more releases.
func (m *Machine) unlockCollector() (*release.Collector, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.stage != StageUnlock || m.collector == nil {
		return nil, wrongStage(StageUnlock, m.stage)
	}
	return m.collector, nil
}

// releaseError maps what the collector refuses to a response.
func releaseError(err error) error {
	switch {
	case errors.Is(err, release.ErrTooEarly):
		return api.Errorf(http.StatusTooEarly, "too_early", "the unlock round is not published yet")
	case errors.Is(err, release.ErrTooLate):
		return api.Errorf(http.StatusConflict, "too_late", "the end round is published, so the paper is already open")
	case errors.Is(err, release.ErrNotHolder):
		return api.Errorf(http.StatusForbidden, "not_on_list", "this passkey is not a key holder on the approved list")
	case errors.Is(err, release.ErrDuplicate):
		return api.Errorf(http.StatusConflict, "already_released", "this holder has already released")
	case errors.Is(err, release.ErrReleased):
		return api.Errorf(http.StatusConflict, "already_unlocked", "K_priv is already rebuilt")
	case errors.Is(err, release.ErrBadShare):
		return badRequest("invalid_share", "the share does not match its published hash")
	case errors.Is(err, release.ErrBadRelease):
		return badRequest("invalid_release", err.Error())
	case errors.Is(err, release.ErrStale):
		return api.Errorf(http.StatusServiceUnavailable, "stale_beacon", "drand's newest round is not current, try again")
	case errors.Is(err, timelock.ErrUnavailable):
		return api.Errorf(http.StatusServiceUnavailable, "stale_beacon", "drand could not be reached, try again")
	case errors.Is(err, challenge.ErrBusy):
		return challengeError(err)
	}
	return err
}

// ReleaseChallenge implements api.Backend. No challenge is issued until the
// unlock round is published.
func (m *Machine) ReleaseChallenge(ctx context.Context) (api.ChallengeResponse, error) {
	c, err := m.unlockCollector()
	if err != nil {
		return api.ChallengeResponse{}, err
	}
	ch, err := c.Challenge(ctx)
	if err != nil {
		return api.ChallengeResponse{}, releaseError(err)
	}
	return api.ChallengeResponse{Challenge: ch}, nil
}

// ReleaseShare implements api.Backend.
func (m *Machine) ReleaseShare(ctx context.Context, req api.ShareRequest) error {
	if m.Stage() == StageReleased {
		return releaseError(release.ErrReleased)
	}
	c, err := m.unlockCollector()
	if err != nil {
		return err
	}
	return releaseError(c.Submit(ctx, req.PasskeyPublicKey, req.Challenge, req.Sealed))
}

// ReleaseLog implements api.Backend.
func (m *Machine) ReleaseLog(context.Context) (release.Log, error) {
	// The log is public once released, so it stays readable. A failed instance
	// serves none.
	m.mu.RLock()
	c, stage := m.collector, m.stage
	m.mu.RUnlock()
	if c == nil || (stage != StageUnlock && stage != StageReleased) {
		return release.Log{}, wrongStage(StageUnlock, stage)
	}
	return c.SignedLog()
}

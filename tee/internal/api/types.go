package api

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
)

// Hex is a byte string, lowercase hex with a 0x prefix in JSON, as in the
// spec's conventions. An empty value is "0x".
type Hex []byte

// MarshalJSON writes 0x-prefixed lowercase hex.
func (h Hex) MarshalJSON() ([]byte, error) {
	return json.Marshal("0x" + hex.EncodeToString(h))
}

// UnmarshalJSON accepts only 0x-prefixed lowercase hex, so a value has one
// spelling.
func (h *Hex) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return errors.New("must be a hex string")
	}
	digits, ok := strings.CutPrefix(s, "0x")
	if !ok {
		return errors.New("must start with 0x")
	}
	if digits != strings.ToLower(digits) {
		return errors.New("must be lowercase hex")
	}
	raw, err := hex.DecodeString(digits)
	if err != nil {
		return errors.New("must be hex")
	}
	*h = raw
	return nil
}

// AttestationResponse is GET /v1/attestation. Token is empty, and Attested
// false, outside Confidential Space: no token is ever made up, and apps refuse
// an instance without one.
type AttestationResponse struct {
	Token                string `json:"token"`
	Attested             bool   `json:"attested"`
	InstancePublicKey    Hex    `json:"instancePublicKey"`
	EncryptionPublicKey  Hex    `json:"encryptionPublicKey"`
	InstanceKeySignature Hex    `json:"instanceKeySignature"`
}

// ApprovedListStatus is the verified list and this instance's signature over it.
type ApprovedListStatus struct {
	ExamID       Hex `json:"examId"`
	Entries      Hex `json:"entries"`
	Hash         Hex `json:"hash"`
	TEESignature Hex `json:"teeSignature"`
}

// ReleaseStatus is how far the release has got. Released holds the passkey
// public keys of holders whose shares were accepted.
type ReleaseStatus struct {
	Released []Hex `json:"released"`
	Required int   `json:"required"`
}

// StatusResponse is GET /v1/status.
type StatusResponse struct {
	Stage         string              `json:"stage"`
	QuestionCount int                 `json:"questionCount"`
	ApprovedList  *ApprovedListStatus `json:"approvedList,omitempty"`
	Release       ReleaseStatus       `json:"release"`
}

// ChallengeResponse is the body of every challenge route.
type ChallengeResponse struct {
	Challenge Hex `json:"challenge"`
}

// RegisterRequest is POST /v1/register. The passkey signature covers the
// registration message. AttestationObject comes from the create ceremony, and
// the other three from the get that signed the message.
type RegisterRequest struct {
	Owner             string `json:"owner"`
	Challenge         Hex    `json:"challenge"`
	PasskeyPublicKey  Hex    `json:"passkeyPublicKey"`
	DerivedPublicKey  Hex    `json:"derivedPublicKey"`
	AttestationObject Hex    `json:"attestationObject"`
	ClientDataJSON    Hex    `json:"clientDataJSON"`
	Signature         Hex    `json:"signature"`
	AuthenticatorData Hex    `json:"authenticatorData"`
}

// QuestionRequest is POST /v1/questions.
type QuestionRequest struct {
	PasskeyPublicKey  Hex `json:"passkeyPublicKey"`
	Ciphertext        Hex `json:"ciphertext"`
	Challenge         Hex `json:"challenge"`
	Signature         Hex `json:"signature"`
	AuthenticatorData Hex `json:"authenticatorData"`
	ClientDataJSON    Hex `json:"clientDataJSON"`
}

// QuestionResponse is the signed receipt.
type QuestionResponse struct {
	QuestionHash Hex `json:"questionHash"`
	TEESignature Hex `json:"teeSignature"`
}

// BuildFields are the Build's fields, apart from examId.
type BuildFields struct {
	ApprovedListHash    Hex    `json:"approvedListHash"`
	PaperHash           Hex    `json:"paperHash"`
	StorageManifestHash Hex    `json:"storageManifestHash"`
	SaltedPaperHash     Hex    `json:"saltedPaperHash"`
	Selected            uint32 `json:"selected"`
	BankSize            uint32 `json:"bankSize"`
	CriteriaHash        Hex    `json:"criteriaHash"`
}

// OutboxMessage is one message for the board to post.
type OutboxMessage struct {
	Kind              string      `json:"kind"`
	ExamID            Hex         `json:"examId"`
	Fields            BuildFields `json:"fields"`
	TEESignature      Hex         `json:"teeSignature"`
	InstancePublicKey Hex         `json:"instancePublicKey"`
}

// OutboxResponse is GET /v1/outbox.
type OutboxResponse struct {
	Messages []OutboxMessage `json:"messages"`
}

// ShareRequest is POST /v1/release/share.
type ShareRequest struct {
	PasskeyPublicKey Hex `json:"passkeyPublicKey"`
	Challenge        Hex `json:"challenge"`
	Sealed           Hex `json:"sealed"`
}

// Registration is one verified registration. The role is set by the board on
// the approved list, not here. DerivedPublicKey is "0x" for a setter.
type Registration struct {
	Owner            string `json:"owner"`
	PasskeyPublicKey Hex    `json:"passkeyPublicKey"`
	DerivedPublicKey Hex    `json:"derivedPublicKey"`
}

// RegistrationsResponse is GET /v1/registrations.
type RegistrationsResponse struct {
	Registrations []Registration `json:"registrations"`
}

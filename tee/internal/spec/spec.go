// Package spec embeds a copy of spec/constants.json, so the image builds from
// tee/ alone. TestConstantsMatchRoot fails if the copy drifts from the root.
package spec

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:generate cp ../../../spec/constants.json constants.json

//go:embed constants.json
var raw []byte

// The two values of chain.readBlock. See "Dev Mode" in spec/api.md: latest is
// for development, and a real exam must use finalized.
const (
	ReadBlockLatest    = "latest"
	ReadBlockFinalized = "finalized"
)

// Constants mirrors spec/constants.json.
type Constants struct {
	Version   int `json:"version"`
	Threshold struct {
		Required int `json:"required"`
		Holders  int `json:"holders"`
		Centres  int `json:"centres"`
		Neutrals int `json:"neutrals"`
	} `json:"threshold"`
	Drand struct {
		Network       string `json:"network"`
		ChainHash     string `json:"chainHash"`
		PublicKey     string `json:"publicKey"`
		Scheme        string `json:"scheme"`
		PeriodSeconds int    `json:"periodSeconds"`
		GenesisTime   int64  `json:"genesisTime"`
	} `json:"drand"`
	Chain struct {
		Name      string `json:"name"`
		ChainID   int64  `json:"chainId"`
		ReadBlock string `json:"readBlock"`
	} `json:"chain"`
	Crypto struct {
		KeyBytes int    `json:"keyBytes"`
		Curve    string `json:"curve"`
		Hash     string `json:"hash"`
		AEAD     string `json:"aead"`
		HPKE     struct {
			KEM  string `json:"kem"`
			KDF  string `json:"kdf"`
			AEAD string `json:"aead"`
			Info struct {
				Question string `json:"question"`
				Share    string `json:"share"`
				Release  string `json:"release"`
				KeyPriv  string `json:"keyPriv"`
			} `json:"info"`
		} `json:"hpke"`
	} `json:"crypto"`
	WebAuthn struct {
		PRFSalt                    string `json:"prfSalt"`
		UserVerification           string `json:"userVerification"`
		RequireHardwareAttestation bool   `json:"requireHardwareAttestation"`
	} `json:"webauthn"`
	Limits struct {
		EntriesBytes   int `json:"entriesBytes"`
		CriteriaBytes  int `json:"criteriaBytes"`
		Entries        int `json:"entries"`
		Topics         int `json:"topics"`
		OwnerBytes     int `json:"ownerBytes"`
		TopicNameBytes int `json:"topicNameBytes"`
		// QuestionOptionsMin and Max bound a multiple choice question's options.
		QuestionOptionsMin int `json:"questionOptionsMin"`
		QuestionOptionsMax int `json:"questionOptionsMax"`
	} `json:"limits"`
	Padding struct {
		QuestionBytes int `json:"questionBytes"`
		PaperBytes    int `json:"paperBytes"`
	} `json:"padding"`
	Attestation struct {
		Issuer           string   `json:"issuer"`
		Audience         string   `json:"audience"`
		SWName           string   `json:"swname"`
		DbgStat          string   `json:"dbgstat"`
		SupportAttribute string   `json:"supportAttribute"`
		HWModels         []string `json:"hwModels"`
	} `json:"attestation"`
	DomainTags struct {
		AttestationNonce   string `json:"attestationNonce"`
		InstanceKey        string `json:"instanceKey"`
		SetterOwner        string `json:"setterOwner"`
		Registration       string `json:"registration"`
		Criteria           string `json:"criteria"`
		ApprovedList       string `json:"approvedList"`
		QuestionSubmission string `json:"questionSubmission"`
		QuestionReceipt    string `json:"questionReceipt"`
		Build              string `json:"build"`
		PaperHash          string `json:"paperHash"`
		ShareHash          string `json:"shareHash"`
		ShareRelease       string `json:"shareRelease"`
		ReleaseLog         string `json:"releaseLog"`
	} `json:"domainTags"`
}

// C holds the embedded constants. An image with invalid constants panics here,
// before main runs, so no code path can start without the check.
var C = mustParse(raw)

func mustParse(b []byte) Constants {
	var c Constants
	if err := json.Unmarshal(b, &c); err != nil {
		panic("spec: embedded constants.json: " + err.Error())
	}
	if err := c.validate(); err != nil {
		panic("spec: embedded constants.json: " + err.Error())
	}
	return c
}

// validate checks the values that go straight to an external system.
// chain.readBlock is sent as a JSON-RPC block tag, so a typo must stop the TEE
// and not reach the RPC operator.
func (c Constants) validate() error {
	switch c.Chain.ReadBlock {
	case ReadBlockLatest, ReadBlockFinalized:
		return nil
	}
	return fmt.Errorf("chain.readBlock must be %q or %q, got %q", ReadBlockLatest, ReadBlockFinalized, c.Chain.ReadBlock)
}

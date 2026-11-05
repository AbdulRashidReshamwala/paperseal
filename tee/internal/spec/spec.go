// Package spec embeds a copy of spec/constants.json, so the image builds from
// tee/ alone. TestConstantsMatchRoot fails if the copy drifts from the root.
package spec

import (
	_ "embed"
	"encoding/json"
)

//go:generate cp ../../../spec/constants.json constants.json

//go:embed constants.json
var raw []byte

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
		Name    string `json:"name"`
		ChainID int64  `json:"chainId"`
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

// C holds the embedded constants.
var C = mustParse(raw)

func mustParse(b []byte) Constants {
	var c Constants
	if err := json.Unmarshal(b, &c); err != nil {
		panic("spec: embedded constants.json: " + err.Error())
	}
	return c
}

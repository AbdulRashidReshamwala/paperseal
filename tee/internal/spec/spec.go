// Package spec embeds copies of spec/constants.json and spec/registry.json, so
// the image builds from tee/ alone. TestConstantsMatchRoot and
// TestRegistryMatchesRoot fail if a copy drifts from the root.
package spec

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:generate cp ../../../spec/constants.json constants.json
//go:generate cp ../../../spec/registry.json registry.json

//go:embed constants.json
var raw []byte

//go:embed registry.json
var rawRegistry []byte

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
	// Schedule bounds Exam Settings beyond what the contract checks.
	Schedule struct {
		MaxDeltaSeconds         uint64 `json:"maxDeltaSeconds"`
		MaxEndAfterStartSeconds uint64 `json:"maxEndAfterStartSeconds"`
	} `json:"schedule"`
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
		PRFInput           string `json:"prfInput"`
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

// Registry mirrors spec/registry.json, the code pin of "Registry Code" in
// spec/api.md. `make abi` writes it.
type Registry struct {
	RuntimeCodeHash string `json:"runtimeCodeHash"`
	ExecutableBytes int    `json:"executableBytes"`
	BoardOffsets    []int  `json:"boardOffsets"`
}

// R holds the embedded code pin. Like C, a bad value panics before main runs.
var R = mustParseRegistry(rawRegistry)

func mustParseRegistry(b []byte) Registry {
	var r Registry
	if err := json.Unmarshal(b, &r); err != nil {
		panic("spec: embedded registry.json: " + err.Error())
	}
	if err := r.validate(); err != nil {
		panic("spec: embedded registry.json: " + err.Error())
	}
	return r
}

// validate refuses a pin no code could match, so it can't slice out of range.
func (r Registry) validate() error {
	if len(r.RuntimeCodeHash) != 66 {
		return fmt.Errorf("runtimeCodeHash must be 32 bytes of 0x hex, got %q", r.RuntimeCodeHash)
	}
	if len(r.BoardOffsets) == 0 {
		return fmt.Errorf("boardOffsets is empty")
	}
	for _, offset := range r.BoardOffsets {
		if offset < 0 || offset+32 > r.ExecutableBytes {
			return fmt.Errorf("board offset %d is outside the %d executable bytes", offset, r.ExecutableBytes)
		}
	}
	return nil
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

// Package chainread is all the TEE reads from the chain: the selection criteria
// and the approved list. The TEE has no wallet and sends no transactions.
//
// Each read has two steps over TLS to exam.RPCHost, for exam.Registry and
// exam.ExamID. First eth_call a getter at the finalized block, which gives the
// record and the one block that holds its log. A record with no block isn't
// written yet, and that is an error. Then call eth_getLogs with fromBlock and
// toBlock both set to that block. Never search a range, because public RPC
// operators reject wide ones.
//
// Root certificates must come from the image, because the image is attested.
// The TLS config must load them from a fixed path in the image into its own
// RootCAs, so neither the host's roots nor SSL_CERT_FILE and SSL_CERT_DIR can
// add one. That is what stops the board's network changing these reads. It can
// still block them.
package chainread

import (
	"context"

	"paperseal/tee/internal/notimpl"
	"paperseal/tee/internal/settings"
)

// Criteria will read getExam, then return the `criteria` bytes emitted in
// ExamCreated at the record's createdBlock. The caller must compare their
// hashing.Criteria hash with exam.CriteriaHash, then check them with
// criteria.Decode.
func Criteria(_ context.Context, _ settings.Exam) ([]byte, error) {
	return nil, notimpl.New("chainread.Criteria")
}

// ApprovedList will read getApprovedList, then return the `entries` bytes
// emitted in ApprovedListPosted at the record's postedBlock, for
// approvedlist.Decode to check.
func ApprovedList(_ context.Context, _ settings.Exam) ([]byte, error) {
	return nil, notimpl.New("chainread.ApprovedList")
}

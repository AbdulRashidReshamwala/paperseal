package api

import (
	"context"

	"paperseal/tee/internal/notimpl"
)

// Unimplemented is the Backend until the lifecycle is written. Every call
// returns a not-implemented error, which the routes turn into a 501.
type Unimplemented struct{}

var _ Backend = Unimplemented{}

func (Unimplemented) Attestation(context.Context) (any, error) {
	return nil, notimpl.New("api.Attestation")
}
func (Unimplemented) Status(context.Context) (any, error) { return nil, notimpl.New("api.Status") }
func (Unimplemented) RegisterChallenge(context.Context, []byte) (any, error) {
	return nil, notimpl.New("api.RegisterChallenge")
}
func (Unimplemented) Register(context.Context, []byte) (any, error) {
	return nil, notimpl.New("api.Register")
}
func (Unimplemented) OnboardList(context.Context, []byte) (any, error) {
	return nil, notimpl.New("api.OnboardList")
}
func (Unimplemented) Questions(context.Context, []byte) (any, error) {
	return nil, notimpl.New("api.Questions")
}
func (Unimplemented) Lock(context.Context, []byte) (any, error) { return nil, notimpl.New("api.Lock") }
func (Unimplemented) Build(context.Context, []byte) (any, error) {
	return nil, notimpl.New("api.Build")
}
func (Unimplemented) Outbox(context.Context) (any, error) { return nil, notimpl.New("api.Outbox") }
func (Unimplemented) ReleaseChallenge(context.Context, []byte) (any, error) {
	return nil, notimpl.New("api.ReleaseChallenge")
}
func (Unimplemented) ReleaseShare(context.Context, []byte) (any, error) {
	return nil, notimpl.New("api.ReleaseShare")
}
func (Unimplemented) ReleaseLog(context.Context) (any, error) {
	return nil, notimpl.New("api.ReleaseLog")
}

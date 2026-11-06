package lifecycle_test

import (
	"net/http"
	"testing"

	"paperseal/tee/internal/api"
	"paperseal/tee/internal/approvedlist"
	"paperseal/tee/internal/hashing"
	"paperseal/tee/internal/webauthn/webauthntest"
)

// byName is a party registering with a passkey made at enrolment: no invite, so
// a zero tag, and one get over the registration message.
func byName(t *testing.T, w *world) *person {
	t.Helper()
	p := newPerson(t, "centre-1.paperseal-demo.eth", approvedlist.RoleCentreHolder)
	p.inviteTag = [32]byte{}
	return p
}

func TestRegisterByAssertionOfAnExistingKey(t *testing.T) {
	w := newWorld(t)
	_, _, h := w.machine()
	c := client{t, h}
	p := byName(t, w)
	if code, why := c.register(p, func(r *api.RegisterRequest) { r.AttestationObject = nil }); code != http.StatusOK {
		t.Fatalf("%d %s", code, why)
	}
	var list api.RegistrationsResponse
	c.mustOK("GET", "/v1/registrations", nil, &list)
	if len(list.Registrations) != 1 || list.Registrations[0].Owner != p.owner {
		t.Fatalf("listed: %+v", list)
	}
	if got := list.Registrations[0].InviteTag; len(got) != 32 || [32]byte(got) != ([32]byte{}) {
		t.Fatalf("a registration by name must keep its 32 zero bytes: %x", got)
	}
}

func TestRegisterByAssertionRefusals(t *testing.T) {
	w := newWorld(t)
	_, _, h := w.machine()
	c := client{t, h}
	withFlags := func(flags byte) func(*person) {
		return func(p *person) { p.passkey.Flags = flags }
	}
	for name, change := range map[string]func(*person){
		"not user present":  withFlags(webauthntest.UV),
		"not user verified": withFlags(webauthntest.UP),
		"backup eligible":   withFlags(webauthntest.UP | webauthntest.UV | webauthntest.BE),
		"backed up":         withFlags(webauthntest.UP | webauthntest.UV | webauthntest.BS),
		"create ceremony":   func(p *person) { p.passkey.Type = "webauthn.create" },
	} {
		p := byName(t, w)
		change(p)
		if code, why := c.register(p, nil); code != http.StatusBadRequest || why != "invalid_signature" {
			t.Errorf("%s: %d %s", name, code, why)
		}
	}
	for name, mutate := range map[string]func(*api.RegisterRequest){
		"another name": func(r *api.RegisterRequest) { r.Owner = "centre-2.paperseal-demo.eth" },
		"a tag added":  func(r *api.RegisterRequest) { r.InviteTag = make([]byte, 32); r.InviteTag[0] = 1 },
		"another key":  func(r *api.RegisterRequest) { r.PasskeyPublicKey = webauthntest.New(t).PublicKey() },
		"short tag":    func(r *api.RegisterRequest) { r.InviteTag = nil },
	} {
		if code, why := c.register(byName(t, w), mutate); code != http.StatusBadRequest {
			t.Errorf("%s: %d %s", name, code, why)
		}
	}
}

// A zero tag is only for a party, so a setter can't register without an invite.
func TestSetterCantUseTheZeroTag(t *testing.T) {
	w := newWorld(t)
	_, _, h := w.machine()
	c := client{t, h}
	p := newPerson(t, "", approvedlist.RoleSetter)
	p.inviteTag = [32]byte{}
	if code, why := c.register(p, nil); code != http.StatusBadRequest || why != "invalid_invite_tag" {
		t.Fatalf("%d %s", code, why)
	}
}

func TestRegisterByAssertionChallengeIsSingleUse(t *testing.T) {
	w := newWorld(t)
	_, _, h := w.machine()
	c := client{t, h}
	p := byName(t, w)
	req := c.registerRequest(p)
	c.mustOK("POST", "/v1/register", req, nil)
	if code, why := c.do("POST", "/v1/register", req, nil); code != http.StatusBadRequest {
		t.Fatalf("replayed: %d %s", code, why)
	}
}

// A signature made for one exam can't register on another: the challenge belongs
// to the instance that issued it. The same key still registers there with a fresh
// one, under its own derived key, because enrolment is permanent.
func TestRegisterByAssertionReplayAcrossExams(t *testing.T) {
	w := newWorld(t)
	_, _, first := w.machine()
	_, _, second := w.machine()
	a, b := client{t, first}, client{t, second}
	p := byName(t, w)
	req := a.registerRequest(p)
	if code, why := b.do("POST", "/v1/register", req, nil); code != http.StatusBadRequest || string(why) != "invalid_challenge" {
		t.Fatalf("replayed on another exam: %d %s", code, why)
	}
	a.mustOK("POST", "/v1/register", req, nil)
	if code, why := b.register(p, nil); code != http.StatusOK {
		t.Fatalf("the same key with a fresh challenge: %d %s", code, why)
	}
}

// The message keeps its layout: a zero tag is a normal bytes32 in the same place.
func TestZeroTagKeepsTheHashLayout(t *testing.T) {
	w := newWorld(t)
	p := byName(t, w)
	zero, err := hashing.Registration(p.derivedKey(), []byte(p.owner), []byte{1}, [32]byte{})
	if err != nil {
		t.Fatal(err)
	}
	tagged, err := hashing.Registration(p.derivedKey(), []byte(p.owner), []byte{1}, [32]byte{1})
	if err != nil {
		t.Fatal(err)
	}
	if len(zero.Encode()) != len(tagged.Encode()) {
		t.Fatalf("lengths differ: %d and %d", len(zero.Encode()), len(tagged.Encode()))
	}
}

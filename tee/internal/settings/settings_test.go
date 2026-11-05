package settings

import (
	"strconv"
	"strings"
	"testing"
)

// With genesisTime 1692803367 and periodSeconds 3, exam-start 1800000000 is
// exactly round 35732212, and start minus delta 1800 is exactly round 35731612.
func valid() map[string]string {
	return map[string]string{
		"exam-id":       "0x" + strings.Repeat("11", 32),
		"exam-start":    "1800000000",
		"delta":         "1800",
		"lock-round":    "100",
		"unlock-round":  "35731612",
		"end-round":     "18446744073709551615",
		"criteria-hash": "0x" + strings.Repeat("22", 32),
		"rpc-host":      "rpc.example.com",
		"registry":      "0x" + strings.Repeat("33", 20),
		"chain-id":      "11155111",
	}
}

// order is the table order in spec/api.md.
var order = []string{
	"exam-id", "exam-start", "delta", "lock-round", "unlock-round",
	"end-round", "criteria-hash", "rpc-host", "registry", "chain-id",
}

func args(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for _, k := range order {
		if v, ok := m[k]; ok {
			out = append(out, "--"+k+"="+v)
		}
	}
	return out
}

func TestParse(t *testing.T) {
	e, err := Parse(args(valid()))
	if err != nil {
		t.Fatal(err)
	}
	if e.ExamID[0] != 0x11 || e.CriteriaHash[31] != 0x22 || e.Registry[19] != 0x33 {
		t.Errorf("hex values not parsed: %+v", e)
	}
	if e.LockRound != 100 || e.UnlockRound != 35731612 || e.EndRound != 1<<64-1 {
		t.Errorf("rounds not parsed: %+v", e)
	}
	if e.ExamStart != 1800000000 || e.Delta != 1800 || e.ChainID != 11155111 || e.RPCHost != "rpc.example.com" {
		t.Errorf("settings not parsed: %+v", e)
	}
}

// The unlock round is the first round at or after T-delta, rounding up, and
// no other value passes.
func TestUnlockRoundFormula(t *testing.T) {
	cases := []struct {
		name, delta string
		want        uint64
	}{
		{"on a round", "1800", 35731612},
		{"one second before a round", "1801", 35731612},
		{"one second after a round", "1799", 35731613},
		{"two seconds after a round", "1798", 35731613},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := valid()
			m["delta"] = c.delta
			m["unlock-round"] = fmtUint(c.want)
			if _, err := Parse(args(m)); err != nil {
				t.Fatalf("exact round refused: %v", err)
			}
			for _, wrong := range []uint64{c.want - 1, c.want + 1} {
				m["unlock-round"] = fmtUint(wrong)
				if _, err := Parse(args(m)); err == nil {
					t.Errorf("round %d accepted", wrong)
				}
			}
		})
	}
}

// A round produced exactly at examStart isn't after it.
func TestEndRoundIsProducedAfterExamStart(t *testing.T) {
	cases := []struct {
		name, start string
		unlock      uint64
		min         uint64
	}{
		{"start on a round", "1800000000", 35731612, 35732213},
		{"start just after a round", "1800000001", 35731613, 35732213},
		{"start just before a round", "1800000002", 35731613, 35732213},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := valid()
			m["exam-start"] = c.start
			m["unlock-round"] = fmtUint(c.unlock)
			m["end-round"] = fmtUint(c.min)
			if _, err := Parse(args(m)); err != nil {
				t.Fatalf("first round after start refused: %v", err)
			}
			m["end-round"] = fmtUint(c.min - 1)
			if _, err := Parse(args(m)); err == nil {
				t.Fatal("round not after exam start accepted")
			}
		})
	}
}

func TestParseRejects(t *testing.T) {
	cases := []struct {
		name, flag, value string
	}{
		{"zero exam", "exam-id", "0x" + strings.Repeat("00", 32)},
		{"short exam", "exam-id", "0x11"},
		{"no prefix", "exam-id", strings.Repeat("11", 32)},
		{"upper hex", "criteria-hash", "0x" + strings.Repeat("AB", 32)},
		{"zero criteria", "criteria-hash", "0x" + strings.Repeat("00", 32)},
		{"zero lock", "lock-round", "0"},
		{"hex round", "lock-round", "0x64"},
		{"leading zero", "lock-round", "0100"},
		{"overflow", "end-round", "18446744073709551616"},
		{"lock at unlock", "lock-round", "35731612"},
		{"lock after unlock", "lock-round", "35731613"},
		{"end at unlock", "end-round", "35731612"},
		{"zero delta", "delta", "0"},
		{"leading zero delta", "delta", "01800"},
		{"delta above start", "delta", "1800000001"},
		{"delta equal to start", "delta", "1800000000"},
		{"start at genesis plus delta", "exam-start", "1692805167"},
		{"maximum delta", "delta", "18446744073709551615"},
		{"short registry", "registry", "0x" + strings.Repeat("33", 19)},
		{"long registry", "registry", "0x" + strings.Repeat("33", 21)},
		{"zero registry", "registry", "0x" + strings.Repeat("00", 20)},
		{"registry without prefix", "registry", strings.Repeat("33", 20)},
		{"checksummed registry", "registry", "0x" + strings.Repeat("aB", 20)},
		{"mainnet", "chain-id", "1"},
		{"zero chain", "chain-id", "0"},
		{"leading zero chain", "chain-id", "011155111"},
		{"hex chain", "chain-id", "0xaa36a7"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := valid()
			m[c.flag] = c.value
			if _, err := Parse(args(m)); err == nil {
				t.Fatal("accepted")
			}
		})
	}
}

func TestRPCHost(t *testing.T) {
	for _, host := range []string{
		"rpc.example.com",
		"eth-sepolia.g.alchemy.com",
		"sepolia.infura.io",
		"a1.b-2.xn--80ak6aa92e.com",
		"localnode",
		"1rpc.io",
	} {
		m := valid()
		m["rpc-host"] = host
		if _, err := Parse(args(m)); err != nil {
			t.Errorf("%s: %v", host, err)
		}
	}
	for _, host := range []string{
		"",
		"https://rpc.example.com",
		"rpc.example.com:443",
		"rpc.example.com/v3/key",
		"rpc.example.com?key=1",
		"rpc.example.com#a",
		"user@rpc.example.com",
		"RPC.example.com",
		"rpc.example.com.",
		".rpc.example.com",
		"rpc..example.com",
		"-rpc.example.com",
		"rpc-.example.com",
		"rpc_1.example.com",
		"rpc example.com",
		" rpc.example.com",
		"rpc.exämple.com",
		"127.0.0.1",
		"1.1.1.0x1",
		"12345",
		"[::1]",
		"::1",
		strings.Repeat("a", 64) + ".com",
		strings.Repeat(strings.Repeat("a", 63)+".", 4) + "com",
	} {
		m := valid()
		m["rpc-host"] = host
		if _, err := Parse(args(m)); err == nil {
			t.Errorf("%q accepted", host)
		}
	}
}

func TestParseRejectsBadShape(t *testing.T) {
	m := valid()
	base := args(m)
	if _, err := Parse(append(clone(base), "extra")); err == nil {
		t.Error("positional argument accepted")
	}
	if _, err := Parse(append(clone(base), "--lock-round=100")); err == nil {
		t.Error("repeated flag accepted")
	}
	if _, err := Parse(append(clone(base), "--unknown=1")); err == nil {
		t.Error("unknown flag accepted")
	}
	for _, removed := range []string{"--selection-round=200", "--board-key=0x04"} {
		if _, err := Parse(append(clone(base), removed)); err == nil {
			t.Errorf("%s accepted", removed)
		}
	}
	if _, err := Parse(nil); err == nil {
		t.Error("no arguments accepted")
	}
	for _, flagName := range order {
		short := valid()
		delete(short, flagName)
		if _, err := Parse(args(short)); err == nil || !strings.Contains(err.Error(), "--"+flagName) {
			t.Errorf("missing %s: %v", flagName, err)
		}
	}
}

// One exact list: any other order or spelling of valid settings is refused.
func TestParseRequiresTheExactList(t *testing.T) {
	base := args(valid())
	swapped := clone(base)
	swapped[0], swapped[1] = swapped[1], swapped[0]
	if _, err := Parse(swapped); err == nil {
		t.Error("swapped arguments accepted")
	}
	singleDash := clone(base)
	singleDash[0] = strings.TrimPrefix(singleDash[0], "-")
	if _, err := Parse(singleDash); err == nil {
		t.Error("single dash accepted")
	}
	name, value, _ := strings.Cut(base[0], "=")
	if _, err := Parse(append([]string{name, value}, base[1:]...)); err == nil {
		t.Error("separate value accepted")
	}
}

// clone returns a copy, so a test can't change the shared list.
func clone(s []string) []string { return append([]string(nil), s...) }

func fmtUint(n uint64) string { return strconv.FormatUint(n, 10) }

package board

import (
	"context"
	"errors"
	"testing"
)

func TestWifiRadioState(t *testing.T) {
	for _, test := range []struct {
		radio                     string
		enabled, hardware, failed bool
	}{
		{"enabled:enabled\n", true, true, false},
		{"enabled:disabled\n", false, true, false},
		{"disabled:enabled\n", true, false, false},
		{"unknown", false, false, true},
	} {
		s := &Service{Run: func(_ context.Context, _ string, args ...string) (string, error) {
			if args[len(args)-1] == "device" {
				return "ethernet\nwifi\nwifi-p2p\n", nil
			}
			return test.radio, nil
		}}
		state, err := s.Wifi(context.Background())
		if (err != nil) != test.failed || state.Enabled != test.enabled || state.HardwareEnabled != test.hardware || !state.Supported {
			t.Fatalf("%q: %+v, %v", test.radio, state, err)
		}
	}
}

func TestWifiUnavailableIsNotDisabled(t *testing.T) {
	s := &Service{Run: func(context.Context, string, ...string) (string, error) {
		return "", errors.New("NetworkManager unavailable")
	}}
	if _, err := s.Wifi(context.Background()); err == nil {
		t.Fatal("failed read reported as disabled")
	}
	s.Run = func(context.Context, string, ...string) (string, error) { return "ethernet\nwifi-p2p\n", nil }
	state, err := s.Wifi(context.Background())
	if err != nil || state.Supported {
		t.Fatalf("missing adapter: %+v, %v", state, err)
	}
}

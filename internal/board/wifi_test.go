package board

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

const testWifiID = "12345678-1234-1234-1234-123456789abc"

func TestWifiReadsBypassWriteLock(t *testing.T) {
	s := &Service{Run: func(_ context.Context, name string, args ...string) (string, error) {
		if name != "sudo" || args[0] != "-n" || args[1] != Helper {
			t.Fatalf("unexpected command: %s %v", name, args)
		}
		switch args[2] {
		case "wifi-status":
			return `{"supported":true,"enabled":false,"hardwareEnabled":true,"device":"wlan0","mode":"off","state":"unavailable","current":null,"saved":[],"hotspot":{"password":"secret123","clients":[]}}`, nil
		case "wifi-scan":
			if args[3] != "1" {
				t.Fatal(args)
			}
			return `{"networks":[]}`, nil
		default:
			t.Fatalf("unexpected helper: %v", args)
		}
		return "", nil
	}}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.Wifi(context.Background())
	if err != nil || !state.Supported || state.Enabled || !state.HardwareEnabled || state.Hotspot.Password != "secret123" {
		t.Fatalf("%+v, %v", state, err)
	}
	if networks, err := s.WifiNetworks(context.Background(), true); err != nil || networks == nil {
		t.Fatalf("%v, %v", networks, err)
	}
	if err := s.SetWifi(context.Background(), true); !errors.Is(err, ErrBusy) {
		t.Fatalf("write must fail immediately: %v", err)
	}
	if err := s.ConnectWifi(context.Background(), WifiConnectRequest{SSID: "Home"}); !errors.Is(err, ErrBusy) {
		t.Fatal(err)
	}
}

func TestWifiReadFailures(t *testing.T) {
	for _, response := range []string{"", "not-json"} {
		s := &Service{Run: func(context.Context, string, ...string) (string, error) { return response, nil }}
		if _, err := s.Wifi(context.Background()); err == nil {
			t.Fatal("invalid status accepted")
		}
		if _, err := s.WifiNetworks(context.Background(), false); err == nil {
			t.Fatal("invalid scan accepted")
		}
	}
	s := &Service{Run: func(context.Context, string, ...string) (string, error) { return "", errors.New("unavailable") }}
	if _, err := s.Wifi(context.Background()); err == nil {
		t.Fatal("failure reported as disabled")
	}
	s.Run = func(context.Context, string, ...string) (string, error) { return `{"supported":false}`, nil }
	state, err := s.Wifi(context.Background())
	if err != nil || state.Supported {
		t.Fatalf("%+v, %v", state, err)
	}
}

func TestWifiValidationBeforeHelper(t *testing.T) {
	s := &Service{Run: func(context.Context, string, ...string) (string, error) {
		t.Fatal("invalid input reached helper")
		return "", nil
	},
		Stream: func(context.Context, io.Reader, io.Writer, string, ...string) error {
			t.Fatal("invalid secret reached helper")
			return nil
		}}
	ctx := context.Background()
	for _, ssid := range []string{"", strings.Repeat("中", 11), "Home\n", "a\x7fb", "a\u0085b", string([]byte{0xff})} {
		if err := s.ConnectWifi(ctx, WifiConnectRequest{SSID: ssid}); err == nil {
			t.Fatalf("accepted SSID %q", ssid)
		}
	}
	for _, password := range []string{"short", strings.Repeat("g", 64), "password\n", "密码password"} {
		if err := s.ConnectWifi(ctx, WifiConnectRequest{SSID: "Home", Password: password}); err == nil {
			t.Fatal("accepted invalid password")
		}
	}
	for _, channel := range []int{-1, 12} {
		if err := s.SetWifiHotspot(ctx, WifiHotspotRequest{SSID: "AP", Channel: channel}); err == nil {
			t.Fatal("accepted invalid channel")
		}
	}
	if err := s.SetWifiHotspot(ctx, WifiHotspotRequest{SSID: "AP", Password: strings.Repeat("a", 64)}); err == nil {
		t.Fatal("accepted raw PSK for hotspot")
	}
	for _, id := range []string{"", "Home", "--help", testWifiID + "\n"} {
		for _, err := range []error{s.ActivateWifi(ctx, id), s.ForgetWifi(ctx, id), s.SetWifiAutoconnect(ctx, id, true)} {
			if err == nil {
				t.Fatalf("accepted invalid UUID %q", id)
			}
		}
	}
	if err := s.SetWifiMode(ctx, "off", false); err == nil {
		t.Fatal("accepted invalid mode")
	}
	for _, ssid := range []string{strings.Repeat("a", 32), strings.Repeat("中", 10), "a:b\\c"} {
		if err := validateWifiSSID(ssid); err != nil {
			t.Fatal(err)
		}
	}
	for _, password := range []string{"", strings.Repeat("a", 8), strings.Repeat("~", 63), strings.Repeat("a", 64)} {
		if err := validateWifiPassword(password, false); err != nil {
			t.Fatal(err)
		}
	}
}

func TestWifiSecretsUseStdinAndSurviveCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s := &Service{Events: &Events{Capacity: 10}}
	calls := 0
	s.Stream = func(ctx context.Context, input io.Reader, _ io.Writer, name string, args ...string) error {
		calls++
		if ctx.Err() != nil {
			t.Fatal("browser cancellation propagated")
		}
		if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) < 100*time.Second {
			t.Fatal("insufficient recovery timeout")
		}
		if name != "sudo" || strings.Contains(strings.Join(args, " "), "secret123") {
			t.Fatal("secret in argv")
		}
		data, _ := io.ReadAll(input)
		var request map[string]any
		if err := json.Unmarshal(data, &request); err != nil || request["password"] != "secret123" {
			t.Fatalf("bad stdin: %v", err)
		}
		return nil
	}
	if err := s.ConnectWifi(ctx, WifiConnectRequest{SSID: "Home", Password: "secret123"}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetWifiHotspot(ctx, WifiHotspotRequest{SSID: "AP", Password: "secret123"}); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatal(calls)
	}
	for _, event := range s.Events.List() {
		if strings.Contains(event.Text, "secret123") {
			t.Fatal("password in events")
		}
	}
	s.Run = func(ctx context.Context, _ string, _ ...string) (string, error) {
		if ctx.Err() != nil {
			t.Fatal("canceled recovery")
		}
		return "", nil
	}
	if err := s.SetWifiMode(ctx, "client", true); err != nil {
		t.Fatal(err)
	}
	if err := s.ActivateWifi(ctx, testWifiID); err != nil {
		t.Fatal(err)
	}
}

func TestWifiUsesAllDeviceAddresses(t *testing.T) {
	s := &Service{Run: func(_ context.Context, name string, args ...string) (string, error) {
		if name != "ip" || strings.Join(args, " ") != "-j address show dev wlan0" {
			t.Fatal(name, args)
		}
		return `[{"addr_info":[{"local":"192.168.1.20"},{"local":"2001:db8::20"},{"local":"fe80::20"}]}]`, nil
	}}
	for _, test := range []struct {
		address string
		want    bool
	}{{"192.168.1.20", true}, {"2001:db8::20", true}, {"fe80::20%wlan0", true}, {"192.168.1.21", false}, {"bad", false}} {
		if got := s.WifiUsesAddress(context.Background(), "wlan0", test.address); got != test.want {
			t.Fatalf("%s: %v", test.address, got)
		}
	}
}

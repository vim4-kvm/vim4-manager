package web

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/board"
)

func TestWifiRejectsMissingOrInvalidState(t *testing.T) {
	called := false
	service := &board.Service{Run: func(context.Context, string, ...string) (string, error) { called = true; return "", nil }}
	handler := Handler(service, fstest.MapFS{})
	for _, body := range []string{`{}`, `{"enabled":null}`, `{"enabled":"off"}`} {
		req := httptest.NewRequest("POST", "/api/wifi", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rsp := httptest.NewRecorder()
		handler.ServeHTTP(rsp, req)
		if rsp.Code != 400 || called {
			t.Fatalf("invalid state %s: status %d, called %v", body, rsp.Code, called)
		}
	}
}

func TestWifiDisabledIsNotMissing(t *testing.T) {
	service := &board.Service{Run: func(_ context.Context, name string, args ...string) (string, error) {
		if name != "sudo" || strings.Join(args, " ") != "-n "+board.Helper+" wifi off" {
			t.Fatalf("unexpected command: %s %v", name, args)
		}
		return "", nil
	}}
	req := httptest.NewRequest("POST", "/api/wifi", strings.NewReader(`{"enabled":false}`))
	req.Header.Set("Content-Type", "application/json")
	rsp := httptest.NewRecorder()
	Handler(service, fstest.MapFS{}).ServeHTTP(rsp, req)
	if rsp.Code != 200 {
		t.Fatal(rsp.Code)
	}
}

func TestWifiViaLocalSocketAddress(t *testing.T) {
	service := &board.Service{Run: func(_ context.Context, name string, args ...string) (string, error) {
		if name == "sudo" {
			return `{"supported":true,"device":"wlan0","mode":"client"}`, nil
		}
		if name != "ip" || strings.Join(args, " ") != "-j address show dev wlan0" {
			t.Fatal(name, args)
		}
		return `[{"addr_info":[{"local":"192.168.5.3"},{"local":"2001:db8::3"}]}]`, nil
	}}
	for _, test := range []struct {
		local string
		want  bool
	}{{"192.168.5.3", true}, {"192.168.5.4", false}, {"2001:db8::3", true}} {
		req := httptest.NewRequest("GET", "/api/wifi", nil)
		// Peer and Host deliberately differ; neither identifies the local NIC.
		req.RemoteAddr = "192.168.5.3:1234"
		req.Host = "192.168.5.3"
		local := &net.TCPAddr{IP: net.ParseIP(test.local), Port: 80}
		req = req.WithContext(context.WithValue(req.Context(), http.LocalAddrContextKey, local))
		rsp := httptest.NewRecorder()
		Handler(service, fstest.MapFS{}).ServeHTTP(rsp, req)
		var state board.WifiState
		if err := json.Unmarshal(rsp.Body.Bytes(), &state); err != nil || rsp.Code != 200 || state.ViaWifi != test.want {
			t.Fatalf("%s: %d %s", test.local, rsp.Code, rsp.Body.String())
		}
	}
}

func TestWifiRoutesAndDetachedWrites(t *testing.T) {
	const id = "12345678-1234-1234-1234-123456789abc"
	for _, test := range []struct {
		route, body, command string
		detached             bool
	}{
		{"connect", `{"ssid":"Home","password":"secret123","hidden":true}`, "wifi-connect", true},
		{"activate", `{"id":"` + id + `"}`, "wifi-activate " + id, true},
		{"disconnect", `{}`, "wifi-disconnect", false},
		{"forget", `{"id":"` + id + `"}`, "wifi-forget " + id, false},
		{"autoconnect", `{"id":"` + id + `","enabled":false}`, "wifi-autoconnect " + id + " no", false},
		{"hotspot", `{"ssid":"AP","password":"secret123","channel":6,"autostart":true}`, "wifi-hotspot", true},
		{"mode", `{"mode":"client","force":true}`, "wifi-mode client force", true},
	} {
		t.Run(test.route, func(t *testing.T) {
			called := false
			check := func(ctx context.Context, name string, args ...string) {
				called = true
				if name != "sudo" || strings.Join(args, " ") != "-n "+board.Helper+" "+test.command {
					t.Fatal(name, args)
				}
				if test.detached {
					if ctx.Err() != nil {
						t.Fatal("client cancellation ended operation")
					}
					if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) < 100*time.Second {
						t.Fatal("recovery deadline too short")
					}
				}
			}
			service := &board.Service{Run: func(ctx context.Context, name string, args ...string) (string, error) {
				check(ctx, name, args...)
				return "", nil
			}}
			service.Stream = func(ctx context.Context, input io.Reader, _ io.Writer, name string, args ...string) error {
				check(ctx, name, args...)
				data, _ := io.ReadAll(input)
				var body map[string]any
				if json.Unmarshal(data, &body) != nil || body["password"] != "secret123" {
					t.Fatal("missing stdin password")
				}
				return nil
			}
			req := httptest.NewRequest("POST", "/api/wifi/"+test.route, strings.NewReader(test.body))
			req.Header.Set("Content-Type", "application/json")
			if test.detached {
				ctx, cancel := context.WithCancel(req.Context())
				cancel()
				req = req.WithContext(ctx)
			}
			rsp := httptest.NewRecorder()
			Handler(service, fstest.MapFS{}).ServeHTTP(rsp, req)
			if rsp.Code != 200 || !called || strings.TrimSpace(rsp.Body.String()) != `{"ok":true}` {
				t.Fatalf("%d %s, called %v", rsp.Code, rsp.Body.String(), called)
			}
		})
	}
}

func TestWifiNewRoutesValidationAndAccess(t *testing.T) {
	service := &board.Service{Run: func(context.Context, string, ...string) (string, error) {
		t.Fatal("invalid request reached helper")
		return "", nil
	},
		Stream: func(context.Context, io.Reader, io.Writer, string, ...string) error {
			t.Fatal("invalid request reached helper")
			return nil
		}}
	handler := Handler(service, fstest.MapFS{})
	for _, test := range []struct{ route, body string }{
		{"connect", `{"ssid":"Home","password":"short"}`}, {"activate", `{"id":"--help"}`},
		{"disconnect", `{`}, {"forget", `{}`}, {"autoconnect", `{"id":"12345678-1234-1234-1234-123456789abc"}`},
		{"hotspot", `{"ssid":"AP","channel":12,"autostart":true}`},
		{"hotspot", `{"ssid":"AP","channel":0}`}, {"mode", `{"mode":"off"}`},
	} {
		req := httptest.NewRequest("POST", "/api/wifi/"+test.route, strings.NewReader(test.body))
		req.Header.Set("Content-Type", "application/json")
		rsp := httptest.NewRecorder()
		handler.ServeHTTP(rsp, req)
		if rsp.Code != 400 {
			t.Fatalf("%s: %d", test.route, rsp.Code)
		}
	}
	for _, route := range []string{"connect", "activate", "disconnect", "forget", "autoconnect", "hotspot", "mode"} {
		for _, access := range []string{"content-type", "origin"} {
			req := httptest.NewRequest("POST", "/api/wifi/"+route, strings.NewReader(`{}`))
			req.Header.Set("Content-Type", "application/json")
			want := 403
			switch access {
			case "content-type":
				req.Header.Set("Content-Type", "text/plain")
				want = 415
			case "origin":
				req.Header.Set("Origin", "http://evil.example")
			}
			rsp := httptest.NewRecorder()
			handler.ServeHTTP(rsp, req)
			if rsp.Code != want {
				t.Fatalf("%s %s: %d", route, access, rsp.Code)
			}
		}
	}
}

func TestWifiScanAndBusyResponse(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	service := &board.Service{Run: func(_ context.Context, _ string, args ...string) (string, error) {
		switch args[2] {
		case "wifi-mode":
			close(entered)
			<-release
			return "", nil
		case "wifi-scan":
			if args[3] != "1" {
				t.Fatal(args)
			}
			return `{"networks":[{"ssid":"Home","signal":90,"security":"WPA2","frequency":2437,"saved":true,"active":true}]}`, nil
		default:
			t.Fatal(args)
			return "", nil
		}
	}}
	done := make(chan error, 1)
	go func() { done <- service.SetWifiMode(context.Background(), "hotspot", false) }()
	<-entered
	defer func() {
		close(release)
		if err := <-done; err != nil {
			t.Error(err)
		}
	}()
	handler := Handler(service, fstest.MapFS{})
	req := httptest.NewRequest("GET", "/api/wifi/networks?rescan=1", nil)
	rsp := httptest.NewRecorder()
	handler.ServeHTTP(rsp, req)
	if rsp.Code != 200 || !strings.Contains(rsp.Body.String(), `"ssid":"Home"`) {
		t.Fatal(rsp.Code, rsp.Body.String())
	}
	req = httptest.NewRequest("POST", "/api/wifi/disconnect", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rsp = httptest.NewRecorder()
	handler.ServeHTTP(rsp, req)
	if rsp.Code != 409 {
		t.Fatal(rsp.Code, rsp.Body.String())
	}
}

package web

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/board"
)

func TestNetworkHTTPErrorLocale(t *testing.T) {
	handler := Handler(&board.Service{}, fstest.MapFS{})
	for _, test := range []struct{ path, body, en, zh string }{
		{"/api/wifi/connect", `{"ssid":""}`, "UTF-8 bytes", "字节"},
		{"/api/tailscale", `{"action":"down"}`, "Confirm", "请确认"},
		{"/api/tailscale/ping", `{"ip":"192.168.1.2"}`, "Tailscale IP", "Tailscale IP"},
		{"/api/wifi/hotspot", `{}`, "integer channel", "channel 整数"},
	} {
		for _, locale := range []string{"en", "zh-CN"} {
			r := httptest.NewRequest("POST", test.path, strings.NewReader(test.body))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Accept-Language", locale)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			var result map[string]string
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			want := test.en
			if locale == "zh-CN" {
				want = test.zh
			}
			if w.Code != 400 || !strings.Contains(result["error"], want) {
				t.Fatalf("%s %s: %d %s", test.path, locale, w.Code, w.Body.String())
			}
		}
	}
}

func TestTailscaleGETAndLogin(t *testing.T) {
	service := &board.Service{Run: func(ctx context.Context, name string, args ...string) (string, error) {
		if name != "sudo" {
			t.Fatalf("unexpected command: %s", name)
		}
		if slices.Equal(args, []string{"-n", board.Helper, "tailscale-status"}) {
			deadline, ok := ctx.Deadline()
			if !ok || time.Until(deadline) > 10*time.Second {
				t.Fatal("GET has no ten-second bound")
			}
			return `{"installed":true,"running":true,"backendState":"NeedsLogin","authURL":"https://head.example/register/1","controlURL":"https://head.example","ips":[],"peers":4,"peersOnline":2}`, nil
		}
		if !slices.Equal(args, []string{"-n", board.Helper, "tailscale-login", "https://head.example"}) {
			t.Fatalf("unexpected arguments: %v", args)
		}
		return `{"authURL":"https://head.example/register/1"}`, nil
	}}
	service.TailscaleHTTP = &http.Client{Transport: statusTransport(func(r *http.Request) (*http.Response, error) {
		data := `{"ControlURL":"https://head.example"}`
		if strings.HasSuffix(r.URL.Path, "/status") {
			data = `{"BackendState":"NeedsLogin","AuthURL":"https://head.example/register/1","Peer":{"a":{"Online":true},"b":{"Online":true}}}`
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(data)), Header: make(http.Header)}, nil
	})}
	handler := Handler(service, fstest.MapFS{})
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/tailscale", nil))
	var state map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || state["authURL"] != "https://head.example/register/1" ||
		state["peersOnline"] != float64(2) || state["job"] != nil || state["dnsName"] != "" {
		t.Fatalf("status: %d %s", w.Code, w.Body.String())
	}
	r := httptest.NewRequest("POST", "/api/tailscale", strings.NewReader(`{"action":"login","controlURL":"https://head.example"}`))
	r.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"authURL":"https://head.example/register/1"}` {
		t.Fatalf("login: %d %s", w.Code, w.Body.String())
	}
}

func TestTailscalePingRouteAndValidation(t *testing.T) {
	calls := 0
	service := &board.Service{Run: func(ctx context.Context, name string, args ...string) (string, error) {
		calls++
		if name != "sudo" || !slices.Equal(args, []string{"-n", board.Helper, "tailscale-ping", "100.64.0.2"}) {
			t.Fatalf("unexpected command: %s %v", name, args)
		}
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > 30*time.Second {
			t.Fatal("ping route has no thirty-second bound")
		}
		return `{"reachable":true,"path":"derp","via":"lax","latencyMs":[15.25],"lost":3,"sent":4}`, nil
	}}
	handler := Handler(service, fstest.MapFS{})
	for _, test := range []struct {
		method, body, contentType string
		code                      int
	}{
		{"POST", `{"ip":"100.64.0.2"}`, "application/json", 200},
		{"POST", `{}`, "application/json", 400},
		{"POST", `{"ip":"192.168.1.1"}`, "application/json", 400},
		{"POST", `{"ip":"100.64.0.2;reboot"}`, "application/json", 400},
		{"POST", `{"ip":false}`, "application/json", 400},
		{"POST", `{"ip":`, "application/json", 400},
		{"POST", `{"ip":"` + strings.Repeat("x", 4096) + `"}`, "application/json", 400},
		{"POST", `{"ip":"100.64.0.2"}`, "text/plain", 415},
		{"GET", "", "", 404},
	} {
		r := httptest.NewRequest(test.method, "/api/tailscale/ping", strings.NewReader(test.body))
		r.Header.Set("Content-Type", test.contentType)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != test.code {
			t.Fatalf("%s %s: %d %s", test.method, test.body, w.Code, w.Body.String())
		}
		if test.code == 200 {
			var result board.TailscalePingResult
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || !result.Reachable ||
				result.Path != "derp" || result.Via != "lax" || !slices.Equal(result.LatencyMs, []float64{15.25}) ||
				result.Lost != 3 || result.Sent != 4 {
				t.Fatalf("ping result: %s, %v", w.Body.String(), err)
			}
		}
	}
	if calls != 1 {
		t.Fatalf("invalid requests reached helper: %d calls", calls)
	}
	service.Run = func(context.Context, string, ...string) (string, error) {
		return "", errors.New("not a current Tailscale peer")
	}
	r := httptest.NewRequest("POST", "/api/tailscale/ping", strings.NewReader(`{"ip":"100.64.0.2"}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "not a current Tailscale peer") {
		t.Fatalf("peer rejection: %d %s", w.Code, w.Body.String())
	}
}

func TestTailscalePingRouteConcurrency(t *testing.T) {
	started, release := make(chan struct{}, 2), make(chan struct{})
	var workers sync.WaitGroup
	defer func() { close(release); workers.Wait() }()
	service := &board.Service{Run: func(context.Context, string, ...string) (string, error) {
		started <- struct{}{}
		<-release
		return `{"reachable":false,"path":"","via":"","latencyMs":[],"lost":4,"sent":4}`, nil
	}}
	handler := Handler(service, fstest.MapFS{})
	post := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/api/tailscale/ping", strings.NewReader(`{"ip":"100.64.0.2"}`))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	for range 2 {
		workers.Add(1)
		go func() { defer workers.Done(); post() }()
	}
	for range 2 {
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("ping did not start")
		}
	}
	if w := post(); w.Code != 409 {
		t.Fatalf("third concurrent request: %d %s", w.Code, w.Body.String())
	}
}

func TestTailscalePOSTValidation(t *testing.T) {
	service := &board.Service{Run: func(context.Context, string, ...string) (string, error) {
		t.Fatal("invalid request reached helper")
		return "", nil
	}}
	handler := Handler(service, fstest.MapFS{})
	for _, test := range []struct {
		body, contentType string
		code              int
	}{
		{`{}`, "application/json", 400},
		{`{"action":"restart"}`, "application/json", 400},
		{`{"action":"login"}`, "application/json", 400},
		{`{"action":"login","controlURL":"https://head.example;reboot"}`, "application/json", 400},
		{`{"action":"up","controlURL":"https://head.example"}`, "application/json", 400},
		{`{"action":false}`, "application/json", 400},
		{`{"action":`, "application/json", 400},
		{`{"action":"` + strings.Repeat("x", 4096) + `"}`, "application/json", 400},
		{`{"action":"up"}`, "text/plain", 415},
	} {
		r := httptest.NewRequest("POST", "/api/tailscale", strings.NewReader(test.body))
		r.Header.Set("Content-Type", test.contentType)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != test.code {
			t.Fatalf("%s: %d %s", test.body, w.Code, w.Body.String())
		}
	}
}

func TestTailscaleDisconnectRequiresConfirmation(t *testing.T) {
	calls := 0
	service := &board.Service{Run: func(context.Context, string, ...string) (string, error) { calls++; return "{}", nil }}
	handler := Handler(service, fstest.MapFS{})
	for _, confirmed := range []bool{false, true} {
		body := fmt.Sprintf(`{"action":"down","confirmed":%t}`, confirmed)
		r := httptest.NewRequest("POST", "/api/tailscale", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		want := 400
		if confirmed {
			want = 200
		}
		if w.Code != want {
			t.Fatalf("confirmed=%t: %d %s", confirmed, w.Code, w.Body.String())
		}
	}
	if calls != 1 {
		t.Fatalf("helper calls: %d", calls)
	}
}

func TestTailscaleErrorsUseExistingResponseCodes(t *testing.T) {
	service := &board.Service{Run: func(context.Context, string, ...string) (string, error) {
		return "", errors.New("helper unavailable")
	}}
	handler := Handler(service, fstest.MapFS{})
	for _, test := range []struct {
		method, body string
		code         int
	}{{"POST", `{"action":"down","confirmed":true}`, 400},
		{"POST", `{"action":"login","controlURL":"https://head.example"}`, 400}} {
		r := httptest.NewRequest(test.method, "/api/tailscale", strings.NewReader(test.body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != test.code || !strings.Contains(w.Body.String(), "helper unavailable") {
			t.Fatalf("response: %d %s", w.Code, w.Body.String())
		}
	}
}

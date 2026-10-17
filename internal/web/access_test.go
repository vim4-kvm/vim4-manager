package web

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/vim4-kvm/vim4-manager/internal/board"
)

type statusTransport func(*http.Request) (*http.Response, error)

func (transport statusTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return transport(r)
}

func TestTailnetCannotWriteAnyManagerRoute(t *testing.T) {
	service := &board.Service{Run: func(context.Context, string, ...string) (string, error) {
		t.Fatal("forbidden write reached helper")
		return "", nil
	}}
	handler := Handler(service, fstest.MapFS{})
	for _, address := range []string{"100.64.0.0:123", "100.127.255.255:123", "[fd7a:115c:a1e0::2]:123", "[::ffff:100.64.0.2]:123"} {
		for _, route := range []string{"/api/tailscale", "/api/select", "/api/wifi", "/api/disks/file"} {
			for _, method := range []string{"POST", "PUT", "DELETE"} {
				r := httptest.NewRequest(method, route, strings.NewReader(`{"action":"login","controlURL":"https://attacker.example"}`))
				r.RemoteAddr = address
				r.Header.Set("Content-Type", "application/json")
				r.Header.Set("X-Forwarded-For", "192.168.1.2")
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, r)
				if w.Code != 403 {
					t.Fatalf("%s %s from %s: %d", method, route, address, w.Code)
				}
			}
		}
	}
}

func TestHostAndOriginValidation(t *testing.T) {
	service := &board.Service{}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	handler := CheckHost(service, localWrites(next), []string{"manager.example", ""})
	for _, test := range []struct {
		host, origin, remote string
		code                 int
	}{
		{"127.0.0.1:80", "", "192.168.1.1:123", 204},
		{"[::1]:80", "", "192.168.1.1:123", 204},
		{"manager.example", "http://manager.example", "192.168.1.1:123", 204},
		{"attacker.example", "http://attacker.example", "192.168.1.1:123", 403},
		{"127.0.0.1", "http://attacker.example", "192.168.1.1:123", 403},
		{"127.0.0.1:bad", "", "192.168.1.1:123", 403},
		{"127.0.0.1", "", "[::ffff:100.64.0.2]:123", 403},
	} {
		r := httptest.NewRequest("POST", "/api/tailscale", nil)
		r.Host = test.host
		r.RemoteAddr = test.remote
		r.Header.Set("Origin", test.origin)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != test.code {
			t.Errorf("host=%s origin=%s remote=%s: %d", test.host, test.origin, test.remote, w.Code)
		}
	}
}

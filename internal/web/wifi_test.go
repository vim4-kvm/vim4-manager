package web

import (
	"context"
	"github.com/vim4-kvm/vim4-manager/internal/board"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
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

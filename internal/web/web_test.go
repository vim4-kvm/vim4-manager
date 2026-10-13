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

func TestCrossSiteFormPostIsRejected(t *testing.T) {
	called := false
	service := &board.Service{Run: func(context.Context, string, ...string) (string, error) {
		called = true
		return "", nil
	}}
	handler := Handler(service, fstest.MapFS{"index.html": {Data: []byte("ok")}})
	for _, contentType := range []string{"application/x-www-form-urlencoded", "text/plain", ""} {
		request := httptest.NewRequest(http.MethodPost, "/api/select", strings.NewReader(`{"app":"jetkvm"}`))
		request.Header.Set("Content-Type", contentType)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnsupportedMediaType {
			t.Errorf("%q: status %d", contentType, response.Code)
		}
	}
	if called {
		t.Fatal("rejected request reached the helper")
	}
	request := httptest.NewRequest(http.MethodPost, "/api/select", strings.NewReader(`{"app":"jetkvm"}`))
	request.Header.Set("Content-Type", "application/json; charset=utf-8")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !called {
		t.Errorf("JSON request: status %d, called %v", response.Code, called)
	}
}

func TestFrontendIsServed(t *testing.T) {
	handler := Handler(&board.Service{}, fstest.MapFS{
		"index.html":      {Data: []byte("<main>")},
		"assets/app-1.js": {Data: []byte("js")},
	})
	for path, cache := range map[string]string{"/": "no-cache", "/assets/app-1.js": "immutable"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK || !strings.Contains(response.Header().Get("Cache-Control"), cache) {
			t.Errorf("%s: %d %q", path, response.Code, response.Header().Get("Cache-Control"))
		}
	}
}

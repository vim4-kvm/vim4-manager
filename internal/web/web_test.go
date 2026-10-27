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

func TestHDRMappingRequiresAnExplicitBoolean(t *testing.T) {
	var calls []string
	service := &board.Service{Run: func(_ context.Context, name string, args ...string) (string, error) {
		calls = append(calls, name+" "+strings.Join(args, " "))
		return "", nil
	}}
	handler := Handler(service, fstest.MapFS{})
	for _, body := range []string{`{}`, `{"enabled":null}`, `{"enabled":"false"}`} {
		r := httptest.NewRequest(http.MethodPost, "/api/hdr-mapping", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest || len(calls) != 0 {
			t.Fatalf("%s: %d %v", body, w.Code, calls)
		}
	}
	r := httptest.NewRequest(http.MethodPost, "/api/hdr-mapping", strings.NewReader(`{"enabled":false}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusOK || len(calls) != 1 || !strings.HasSuffix(calls[0], "hdr-mapping false") {
		t.Fatalf("explicit false: %d %v", w.Code, calls)
	}
}

func TestMediaChangesRequireExplicitModeAndEjectConfirmation(t *testing.T) {
	called := false
	service := &board.Service{Run: func(context.Context, string, ...string) (string, error) {
		called = true
		return "", nil
	}}
	handler := Handler(service, fstest.MapFS{})
	for _, test := range []struct{ path, body string }{
		{"/api/media/mount", `{"app":"onekvm","image":"shared/disk.img"}`},
		{"/api/media/mount", `{"app":"onekvm","image":"shared/disk.img","cdrom":false,"readOnly":null}`},
		{"/api/media/eject", `{"token":"old","confirmed":false}`},
	} {
		r := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest || called {
			t.Fatalf("%s: status %d, helper called %v", test.path, w.Code, called)
		}
	}
}

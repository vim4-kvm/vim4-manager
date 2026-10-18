package web

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/vim4-kvm/vim4-manager/internal/auth"
	"github.com/vim4-kvm/vim4-manager/internal/board"
)

func TestAuthenticatedManagerBoundaries(t *testing.T) {
	s, e := auth.Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	assets := fstest.MapFS{
		"login.html":             {Data: []byte("login")},
		"__vim4/assets/login.js": {Data: []byte("login-script")},
	}
	handler := AuthenticatedHandler(&board.Service{}, assets, s)
	for _, path := range []string{"/__vim4/login", "/__vim4/assets/login.js"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 {
			t.Fatal(path, w.Code)
		}
	}
	for _, path := range []string{"/api/status", "/api/account/sessions", "/api/disks/file", "/api/unknown"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 401 {
			t.Fatalf("%s: %d", path, w.Code)
		}
	}
	request := func(path, body, peer, origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", path, strings.NewReader(body))
		r.RemoteAddr = peer
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if w := request("/__vim4/api/auth/setup", `{"username":"admin","password":"password1"}`, "127.0.0.1:1", ""); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w := request("/__vim4/api/auth/setup", `{"username":"admin","password":"password1"}`, "192.168.1.1:1", "http://evil.test"); w.Code != 403 {
		t.Fatal(w.Code)
	}
	w := request("/__vim4/api/auth/setup", `{"username":"admin","password":"password1"}`, "192.168.1.1:1", "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	cookie := w.Result().Cookies()[0]
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" || cookie.Secure {
		t.Fatal(cookie)
	}
	if w := request("/__vim4/api/auth/setup", `{"username":"admin","password":"password1"}`, "192.168.1.1:1", ""); w.Code != 409 {
		t.Fatal(w.Code)
	}
	r := httptest.NewRequest("GET", "/api/account/sessions", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 200 || strings.Contains(w.Body.String(), "digest") {
		t.Fatal(w.Code, w.Body.String())
	}
	if e = s.SetPassword(context.Background(), "admin", "replacement"); e != nil {
		t.Fatal(e)
	}
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
}

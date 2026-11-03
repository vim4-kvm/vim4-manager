package web

import (
	"bytes"
	"context"
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/vim4-kvm/vim4-manager/internal/auth"
	"github.com/vim4-kvm/vim4-manager/internal/board"
)

func TestHTTPRedirects(t *testing.T) {
	settings, err := board.OpenHTTPS(t.TempDir(), ":443", ":8443", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = settings.SetHTTP(false); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		host, port, peer, target string
		secure                   bool
	}{
		{"box:80", ":443", "192.0.2.2:1", "https://box/a?x=1", false},
		{"box:8080", ":8443", "192.0.2.2:1", "https://box:8443/a?x=1", false},
		{"[2001:db8::1]:8080", ":8443", "192.0.2.2:1", "https://[2001:db8::1]:8443/a?x=1", false},
		{"box:18080", ":18443", "192.0.2.2:1", "https://box:18443/a?x=1", false},
		{"box", ":443", "127.0.0.1:1", "", false},
		{"box", ":443", "[::1]:1", "", false},
		{"box", ":443", "192.0.2.2:1", "", true},
	} {
		h := HTTPAccess(settings, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }), test.port)
		r := httptest.NewRequest("POST", "http://"+test.host+"/a?x=1", nil)
		r.RemoteAddr = test.peer
		if test.secure {
			r.TLS = &tls.ConnectionState{}
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		want := 308
		if test.target == "" {
			want = 204
		}
		if w.Code != want || w.Header().Get("Location") != test.target || w.Header().Get("Strict-Transport-Security") != "" {
			t.Fatal(test, w.Code, w.Header())
		}
	}
	if err = settings.SetHTTP(true); err != nil {
		t.Fatal(err)
	}
	h := HTTPAccess(settings, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }), ":443")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://box/", nil))
	if w.Code != 204 {
		t.Fatal(w.Code)
	}
}

func TestHTTPSAPI(t *testing.T) {
	dir := t.TempDir()
	sessions, err := auth.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	retried := make(chan struct{})
	settings, err := board.OpenHTTPS(dir, ":443", ":8443", func(_ context.Context, _ string, _ ...string) (string, error) { close(retried); return "", nil })
	if err != nil {
		t.Fatal(err)
	}
	service := &board.Service{HTTPS: settings}
	h := AuthenticatedHandler(service, fstest.MapFS{}, sessions)
	call := func(method, path, body string, secure bool, cookie *http.Cookie, origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://localhost"+path, strings.NewReader(body))
		r.RemoteAddr = "192.168.1.1:1234"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", origin)
		if secure {
			r.TLS = &tls.ConnectionState{}
		}
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	ca := call("GET", "/__vim4/ca.crt", "", false, nil, "")
	if ca.Code != 200 || !bytes.Equal(ca.Body.Bytes(), settings.CA()) || ca.Header().Get("Content-Type") != "application/x-x509-ca-cert" || ca.Header().Get("Content-Disposition") != `attachment; filename="vim4-kvm-ca.crt"` {
		t.Fatal(ca)
	}
	if w := call("GET", "/__vim4/api/https", "", false, nil, ""); w.Code != 401 {
		t.Fatal(w.Code)
	}
	setup := call("POST", "/__vim4/api/auth/setup", `{"username":"admin","password":"password1"}`, false, nil, "")
	if setup.Code != 200 {
		t.Fatal(setup.Code, setup.Body.String())
	}
	cookie := setup.Result().Cookies()[0]
	// Cookie security may trust a local proxy, but switching off HTTP requires
	// this listener's own TLS connection as specified by the recovery contract.
	request := httptest.NewRequest("PUT", "http://localhost/__vim4/api/https", strings.NewReader(`{"http_enabled":false}`))
	request.RemoteAddr = "127.0.0.1:1234"
	request.Header.Set("X-Forwarded-Proto", "https")
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != http.StatusConflict {
		t.Fatal(response.Code, response.Body.String())
	}
	for _, test := range []struct {
		method, path, body, origin string
		secure                     bool
		code                       int
		contains                   string
	}{
		{"GET", "/__vim4/api/https", "", "", false, 200, `"request_secure":false`},
		{"PUT", "/__vim4/api/https", `{"http_enabled":false}`, "", false, 409, `"error":"https_required"`},
		{"PUT", "/__vim4/api/https", `{"http_enabled":false}`, "", true, 200, `"http_enabled":false`},
		{"GET", "/__vim4/api/https", "", "", true, 200, `"request_secure":true`},
		{"PUT", "/__vim4/api/https", `{"http_enabled":true}`, "", false, 200, `"http_enabled":true`},
		{"PUT", "/__vim4/api/https", `{}`, "", true, 400, "required"},
		{"PUT", "/__vim4/api/https", `{"http_enabled":false}`, "https://evil.test", true, 403, ""},
		{"POST", "/__vim4/api/https/tailscale/retry", `{}`, "", true, 202, ""},
	} {
		w := call(test.method, test.path, test.body, test.secure, cookie, test.origin)
		if w.Code != test.code || !strings.Contains(w.Body.String(), test.contains) {
			t.Fatal(test, w.Code, w.Body.String())
		}
	}
	<-retried
}

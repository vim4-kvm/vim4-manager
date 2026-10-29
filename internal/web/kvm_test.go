package web

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/auth"
	"github.com/vim4-kvm/vim4-manager/internal/board"
)

type gatewayFixture struct {
	store  *auth.Store
	cookie *http.Cookie
	app    atomic.Value
	server *httptest.Server
}

func newGateway(t *testing.T, backend http.Handler) *gatewayFixture {
	t.Helper()
	b := httptest.NewServer(backend)
	t.Cleanup(b.Close)
	s, err := auth.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	token, err := s.Setup(context.Background(), netip.MustParseAddr("192.168.1.2"), "test", "admin", "password1")
	if err != nil {
		t.Fatal(err)
	}
	f := &gatewayFixture{store: s, cookie: &http.Cookie{Name: auth.CookieName, Value: token}}
	f.app.Store("nanokvm")
	service := &board.Service{Run: func(ctx context.Context, name string, args ...string) (string, error) {
		var result strings.Builder
		for _, app := range board.Apps {
			enabled := "disabled"
			if app.ID == f.app.Load().(string) {
				enabled = "enabled"
			}
			fmt.Fprintf(&result, "Id=%s\nLoadState=loaded\nActiveState=active\nUnitFileState=%s\n\n", app.Unit, enabled)
		}
		return result.String(), nil
	}}
	assets := fstest.MapFS{"login.html": {Data: []byte("login")}, "__vim4/assets/login.js": {Data: []byte("script")}}
	f.server = httptest.NewServer(KVMHandler(service, assets, s, strings.TrimPrefix(b.URL, "http://"), []string{"gateway.test"}))
	t.Cleanup(f.server.Close)
	return f
}

func (f *gatewayFixture) request(t *testing.T, method, path string, login bool, headers http.Header, body io.Reader) *http.Response {
	t.Helper()
	r, err := http.NewRequest(method, f.server.URL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	r.Header = headers.Clone()
	if r.Header == nil {
		r.Header = make(http.Header)
	}
	if login {
		r.AddCookie(f.cookie)
	}
	client := &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

func TestKVMBoundaries(t *testing.T) {
	f := newGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	for _, tc := range []struct {
		method, path string
		login        bool
		headers      http.Header
		code         int
	}{
		{"GET", "/view?a=1&b=two", false, http.Header{"Accept": {"text/html"}}, 302},
		{"GET", "/api/status", false, nil, 401},
		{"GET", "/ws", false, http.Header{"Accept": {"text/html"}, "Connection": {"Upgrade"}, "Upgrade": {"websocket"}}, 401},
		{"GET", "/redfish", false, nil, 404},
		{"POST", "/redfish/v1", true, nil, 404},
		{"GET", "/other/../redfish/v1", true, nil, 404},
		{"GET", "/__vim4/login?next=/", false, nil, 200},
		{"GET", "/__vim4/assets/login.js", false, nil, 200},
		{"POST", "/upload", true, http.Header{"Origin": {"http://evil.test"}}, 403},
		{"GET", "/ws", true, http.Header{"Origin": {"http://evil.test"}, "Connection": {"Upgrade"}, "Upgrade": {"websocket"}}, 403},
		{"POST", "/upload", true, http.Header{"Origin": {strings.Replace(f.server.URL, "http:", "https:", 1)}}, 403},
		{"POST", "/upload", true, http.Header{"Origin": {f.server.URL}}, 204},
		{"GET", "/", true, nil, 204},
	} {
		t.Run(tc.method+tc.path+fmt.Sprint(tc.code), func(t *testing.T) {
			r := f.request(t, tc.method, tc.path, tc.login, tc.headers, nil)
			if r.StatusCode != tc.code {
				t.Fatalf("status %d, want %d", r.StatusCode, tc.code)
			}
			if tc.code == 302 && r.Header.Get("Location") != "/__vim4/login?next=%2Fview%3Fa%3D1%26b%3Dtwo" {
				t.Fatal(r.Header)
			}
		})
	}
	for _, path := range []string{"/__vim4/login", "/__vim4/login?next=//evil.test"} {
		res := f.request(t, "GET", path, false, nil, nil)
		if res.StatusCode != 302 || res.Header.Get("Location") != "/__vim4/login?next=%2F" {
			t.Fatal(res.StatusCode, res.Header)
		}
	}
	res := f.request(t, "POST", "/__vim4/api/auth/login", false, http.Header{"Content-Type": {"application/json"}}, strings.NewReader(`{"username":"admin","password":"password1"}`))
	if res.StatusCode != 200 || len(res.Cookies()) != 1 || res.Cookies()[0].Name != auth.CookieName {
		t.Fatal("gateway login", res.StatusCode, res.Header)
	}
	for host, code := range map[string]int{"gateway.test:8080": 204, "203.0.113.9:8080": 403} {
		r, _ := http.NewRequest("GET", f.server.URL, nil)
		r.Host = host
		r.AddCookie(f.cookie)
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != code {
			t.Fatalf("host %s: %d", host, res.StatusCode)
		}
	}
}

func TestKVMUnconfiguredRejectsMCP(t *testing.T) {
	s, err := auth.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := &board.Service{Run: func(context.Context, string, ...string) (string, error) {
		return "UnitFileState=disabled\n\nUnitFileState=enabled\n\nUnitFileState=disabled\n\nUnitFileState=disabled\n", nil
	}}
	h := KVMHandler(service, fstest.MapFS{}, s, "127.0.0.1:1", nil)
	r := httptest.NewRequest("POST", "http://localhost:8080/api/mcp", nil)
	r.Header.Set("Authorization", "Bearer key")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestKVMForwardingAndUpload(t *testing.T) {
	seen := make(chan *http.Request, 1)
	size := int64(8 << 20)
	f := newGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, err := io.Copy(io.Discard, r.Body)
		if err != nil || n != size {
			t.Errorf("upload %d: %v", n, err)
		}
		seen <- r.Clone(context.Background())
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("X-Application", "preserved")
		w.Write([]byte("ok"))
	}))
	h := http.Header{"X-Forwarded-For": {"forged"}, "X-Forwarded-Proto": {"http"}, "X-Forwarded-Host": {"evil"}, "X-Forwarded-Extra": {"evil"}, "Forwarded": {"evil"}, "X-Real-Ip": {"evil"}, "X-Kvmd-User": {"admin"}, "X-Kvmd-Passwd": {"secret"}, "Authorization": {"Bearer stolen"}, "Cookie": {f.cookie.String() + "; application=value; vim4_session=wrong"}, "Connection": {"X-Real-IP"}}
	r := f.request(t, "POST", "/upload", true, h, bytes.NewReader(make([]byte, size)))
	if r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
	got := <-seen
	for _, name := range []string{"X-Forwarded-Host", "X-Forwarded-Extra", "Forwarded", "X-Kvmd-User", "X-Kvmd-Passwd", "Authorization"} {
		if got.Header.Get(name) != "" {
			t.Errorf("leaked %s", name)
		}
	}
	if got.Host != strings.TrimPrefix(f.server.URL, "http://") || got.Header.Get("X-Forwarded-For") != "127.0.0.1" || got.Header.Get("X-Real-IP") != "127.0.0.1" || got.Header.Get("X-Forwarded-Proto") != "http" {
		t.Fatal(got.Host, got.Header)
	}
	if got.Header.Get("Cookie") != "application=value" {
		t.Fatal(got.Header.Get("Cookie"))
	}
	if r.Header.Get("Access-Control-Allow-Origin") != "" || r.Header.Get("Access-Control-Allow-Credentials") != "" || r.Header.Get("X-Application") != "preserved" {
		t.Fatal(r.Header)
	}
}

func TestKVMMCP(t *testing.T) {
	f := newGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/mcp" && r.Header.Get("Authorization") != "Bearer key" {
			w.WriteHeader(401)
			return
		}
		w.WriteHeader(204)
	}))
	for _, app := range []string{"nanokvm", "onekvm", "jetkvm", "pikvm", ""} {
		f.app.Store(app)
		for _, path := range []string{"/api/mcp", "/api/mcp/config", "/api/mcp/key/regenerate"} {
			code := 401
			if path == "/api/mcp" && (app == "nanokvm" || app == "onekvm") {
				code = 204
			}
			r := f.request(t, "POST", path, false, http.Header{"Authorization": {"Bearer key"}}, nil)
			if r.StatusCode != code {
				t.Fatalf("%s %s: %d", app, path, r.StatusCode)
			}
		}
	}
	f.app.Store("onekvm")
	if r := f.request(t, "POST", "/api/mcp", false, nil, nil); r.StatusCode != 401 {
		t.Fatal(r.StatusCode)
	}
	if r := f.request(t, "POST", "/api/mcp", false, http.Header{"Authorization": {"Bearer key"}, "Origin": {"http://evil.test"}}, nil); r.StatusCode != 403 {
		t.Fatal(r.StatusCode)
	}
	if r := f.request(t, "GET", "/api/mcp/config", true, nil, nil); r.StatusCode != 204 {
		t.Fatal(r.StatusCode)
	}
}

func TestKVMStreamRevocation(t *testing.T) {
	next := make(chan struct{})
	backendDone := make(chan struct{})
	f := newGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(backendDone)
		w.Header().Set("Content-Type", "multipart/x-mixed-replace; boundary=frame")
		w.Write([]byte("first\n"))
		w.(http.Flusher).Flush()
		select {
		case <-next:
		case <-r.Context().Done():
			return
		}
		w.Write([]byte("second\n"))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	r := f.request(t, "GET", "/stream", true, nil, nil)
	reader := bufio.NewReader(r.Body)
	if line, err := reader.ReadString('\n'); err != nil || line != "first\n" {
		t.Fatal(line, err)
	}
	close(next)
	if line, err := reader.ReadString('\n'); err != nil || line != "second\n" {
		t.Fatal(line, err)
	}
	if err := f.store.Revoke(f.store.Sessions()[0].ID, false); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := reader.ReadByte(); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("stream still open")
		}
	case <-time.After(time.Second):
		t.Fatal("stream not disconnected")
	}
	select {
	case <-backendDone:
	case <-time.After(time.Second):
		t.Fatal("backend not canceled")
	}
}

func TestKVMWebSocketRevocation(t *testing.T) {
	backendDone := make(chan struct{})
	f := newGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		defer close(backendDone)
		sum := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
		fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: %s\r\n\r\n", base64.StdEncoding.EncodeToString(sum[:]))
		rw.Flush()
		// A masked client text frame followed by an unmasked server frame.
		frame := make([]byte, 8)
		if _, err := io.ReadFull(rw, frame); err != nil {
			t.Error(err)
			return
		}
		if !bytes.Equal(frame, []byte{0x81, 0x82, 1, 2, 3, 4, 'h' ^ 1, 'i' ^ 2}) {
			t.Errorf("frame %x", frame)
		}
		rw.Write([]byte{0x81, 2, 'o', 'k'})
		rw.Flush()
		io.Copy(io.Discard, rw)
	}))
	conn, err := net.Dial("tcp", strings.TrimPrefix(f.server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	fmt.Fprintf(conn, "GET /ws HTTP/1.1\r\nHost: %s\r\nOrigin: %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: %s\r\n\r\n", strings.TrimPrefix(f.server.URL, "http://"), f.server.URL, f.cookie.String())
	reader := bufio.NewReader(conn)
	res, err := http.ReadResponse(reader, &http.Request{Method: "GET"})
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 101 {
		t.Fatal(res.StatusCode)
	}
	conn.Write([]byte{0x81, 0x82, 1, 2, 3, 4, 'h' ^ 1, 'i' ^ 2})
	frame := make([]byte, 4)
	if _, err := io.ReadFull(reader, frame); err != nil || !bytes.Equal(frame, []byte{0x81, 2, 'o', 'k'}) {
		t.Fatal(frame, err)
	}
	if err := f.store.Revoke(f.store.Sessions()[0].ID, false); err != nil {
		t.Fatal(err)
	}
	conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := reader.ReadByte(); err == nil {
		t.Fatal("WS still open")
	} else if e, ok := err.(net.Error); ok && e.Timeout() {
		t.Fatal("WS not disconnected within one second")
	}
	select {
	case <-backendDone:
	case <-time.After(time.Second):
		t.Fatal("backend WS not closed")
	}
}

func TestKVMUnavailable(t *testing.T) {
	b := httptest.NewServer(http.NotFoundHandler())
	b.Close()
	s, err := auth.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	token, err := s.Setup(context.Background(), netip.MustParseAddr("192.168.1.2"), "test", "admin", "password1")
	if err != nil {
		t.Fatal(err)
	}
	h := KVMHandler(&board.Service{}, fstest.MapFS{}, s, strings.TrimPrefix(b.URL, "http://"), []string{"gateway.test"})
	for _, accept := range []string{"text/html", "application/json"} {
		r := httptest.NewRequest("GET", "http://gateway.test:8080/", nil)
		r.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
		r.Header.Set("Accept", accept)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 502 {
			t.Fatal(w.Code)
		}
		if accept == "text/html" && (!strings.Contains(w.Body.String(), "http://gateway.test/#/apps") || !strings.Contains(w.Body.String(), "prefers-color-scheme:dark")) {
			t.Fatal(w.Body.String())
		}
		if accept == "application/json" && !strings.Contains(w.Header().Get("Content-Type"), "application/json") {
			t.Fatal(w.Header())
		}
	}
}

func TestKVMBindRetryKeepsManagerAvailable(t *testing.T) {
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	address := occupied.Addr().String()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := &board.Events{Capacity: 10}
	done := make(chan error, 1)
	go func() {
		done <- ServeKVM(ctx, address, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }), events)
	}()
	s, err := auth.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	manager := httptest.NewServer(CheckHost(&board.Service{}, AuthenticatedHandler(&board.Service{}, fstest.MapFS{}, s), nil))
	defer manager.Close()
	deadline := time.Now().Add(time.Second)
	for len(events.List()) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if rows := events.List(); len(rows) != 1 || rows[0].Text != "KVM gateway is waiting for port 8080" {
		t.Fatal(rows)
	}
	res, err := http.Get(manager.URL + "/__vim4/api/auth/state")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	occupied.Close()
	deadline = time.Now().Add(3 * time.Second)
	client := &http.Client{Timeout: 100 * time.Millisecond}
	bound := false
	for time.Now().Before(deadline) {
		res, err = client.Get("http://" + address)
		if err == nil {
			res.Body.Close()
			bound = res.StatusCode == 204
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !bound {
		t.Fatal("gateway did not bind after release")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("gateway did not stop")
	}
	if rows := events.List(); len(rows) != 2 || rows[0].Text != "KVM gateway started" {
		t.Fatal(rows)
	}
}

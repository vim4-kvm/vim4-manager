package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var lan = netip.MustParseAddr("192.168.1.2")
var remote = netip.MustParseAddr("100.64.1.2")

func store(t *testing.T) *Store {
	t.Helper()
	s, e := Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	return s
}

func setup(t *testing.T, s *Store) string {
	t.Helper()
	token, e := s.Setup(context.Background(), lan, "test", "admin", "password1")
	if e != nil {
		t.Fatal(e)
	}
	return token
}

func TestSourceNextAndPasswordBoundaries(t *testing.T) {
	for _, v := range []struct {
		address string
		allowed bool
	}{
		{"192.168.1.1", true},
		{"10.0.0.1", true},
		{"172.16.0.1", true},
		{"172.32.0.1", false},
		{"169.254.1.1", true},
		{"fe80::1", true},
		{"fd12::1", true},
		{"fc00::1", true},
		{"fd7a:115c:a1e0::1", false},
		{"100.64.0.1", false},
		{"100.127.255.255", false},
		{"127.0.0.2", false},
		{"::1", false},
		{"8.8.8.8", false},
		{"::ffff:192.168.1.1", true},
		{"::ffff:100.64.0.1", false},
	} {
		if LAN(netip.MustParseAddr(v.address)) != v.allowed {
			t.Error(v)
		}
	}
	for _, v := range []string{"//evil.test", "/\\evil.test", "https://evil.test", "/\n/evil.test", "/foo\\bar"} {
		if Next(v) != "/" {
			t.Error(v)
		}
	}
	if Next("/#/account") != "/#/account" {
		t.Fatal("safe path lost")
	}
	for _, password := range []string{"short", "admin", strings.Repeat("密", 129)} {
		if Validate("admin", password) == nil {
			t.Error(password)
		}
	}
	if Validate("admin", strings.Repeat("密", 128)) != nil {
		t.Fatal("unicode length")
	}
	for _, v := range []struct {
		peer, proto string
		secure      bool
	}{
		{"127.0.0.1:1", "https", true},
		{"[::1]:1", "https", true},
		{"[::ffff:127.0.0.1]:1", "https", true},
		{"192.168.1.1:1", "https", false},
		{"127.0.0.1:1", "http", false},
	} {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = v.peer
		r.Header.Set("X-Forwarded-Proto", v.proto)
		if Secure(r) != v.secure {
			t.Error(v)
		}
	}
}

func TestSessionPersistenceExpiryAndRevocation(t *testing.T) {
	s := store(t)
	token := setup(t, s)
	v := s.Authenticate(token, lan)
	if v == nil {
		t.Fatal("missing session")
	}
	disk, e := os.ReadFile(filepath.Join(s.dir, "sessions.json"))
	if e != nil || bytes.Contains(disk, []byte(token)) {
		t.Fatal("raw token persisted", e)
	}
	for _, file := range []string{"auth.json", "sessions.json"} {
		info, e := os.Stat(filepath.Join(s.dir, file))
		if e != nil || info.Mode().Perm() != 0600 {
			t.Fatal("permissions", file, e)
		}
	}
	recovered, e := Open(s.dir)
	if e != nil || recovered.Authenticate(token, lan) == nil {
		t.Fatal("restart", e)
	}
	if e = s.Revoke(v.ID, false); e != nil {
		t.Fatal(e)
	}
	select {
	case <-v.ctx.Done():
	default:
		t.Fatal("session not cancelled")
	}
	again, e := Open(s.dir)
	if e != nil || again.Authenticate(token, lan) != nil {
		t.Fatal("revocation persisted", e)
	}
	for _, test := range []struct {
		name      string
		ip        netip.Addr
		age, idle time.Duration
		valid     bool
	}{
		{"LAN idle inside", lan, 6 * 24 * time.Hour, 6 * 24 * time.Hour, true},
		{"LAN idle expired", lan, 7 * 24 * time.Hour, 7 * 24 * time.Hour, false},
		{"LAN absolute", lan, 30 * 24 * time.Hour, time.Minute, false},
		{"remote idle inside", remote, 59 * time.Minute, 59 * time.Minute, true},
		{"remote idle expired", remote, time.Hour, time.Hour, false},
		{"remote absolute", remote, 24 * time.Hour, time.Minute, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			s.mu.Lock()
			token, e := s.create(lan, "test")
			if e != nil {
				t.Fatal(e)
			}
			v := s.sessions[digest(token)]
			v.Created = s.now().Add(-test.age)
			v.LastActive = s.now().Add(-test.idle)
			s.mu.Unlock()
			if (s.Authenticate(token, test.ip) != nil) != test.valid {
				t.Fatal("wrong expiry")
			}
		})
	}
}

func TestSessionLimitAndCredentialChanges(t *testing.T) {
	s := store(t)
	first := setup(t, s)
	old := s.Authenticate(first, lan)
	s.mu.Lock()
	for i := 0; i < 20; i++ {
		if _, e := s.create(lan, "test"); e != nil {
			t.Fatal(e)
		}
	}
	s.mu.Unlock()
	if len(s.Sessions()) != 20 || s.Authenticate(first, lan) != nil || old.ctx.Err() == nil {
		t.Fatal("oldest not evicted")
	}
	token, e := s.Login(context.Background(), lan, "test", "admin", "password1")
	if e != nil {
		t.Fatal(e)
	}
	current := s.Authenticate(token, lan)
	if e = s.Change(context.Background(), lan, current, "password1", "", "newpassword"); e != nil {
		t.Fatal(e)
	}
	if len(s.Sessions()) != 1 || s.Authenticate(token, lan) == nil {
		t.Fatal("password change must retain current")
	}
	if _, e = s.Login(context.Background(), lan, "test", "admin", "password1"); !errors.Is(e, ErrCredentials) {
		t.Fatal(e)
	}
	if e = s.Change(context.Background(), lan, current, "newpassword", "new-admin", ""); e != nil {
		t.Fatal(e)
	}
	if s.Credentials().Username != "new-admin" {
		t.Fatal("username unchanged")
	}
	recovered, e := Open(s.dir)
	if e != nil || recovered.Authenticate(token, lan) == nil {
		t.Fatal("current session not persisted with new version", e)
	}
}

func TestLimiter(t *testing.T) {
	var l limiter
	now := time.Now()
	loop := netip.MustParseAddr("127.0.0.1")
	loop6 := netip.MustParseAddr("::1")
	for i := 0; i < 5; i++ {
		l.result(loop, now, false)
	}
	if retry, _ := l.check(loop6, now); retry != 30 {
		t.Fatal(retry)
	}
	if retry, _ := l.check(lan, now); retry != 0 {
		t.Fatal("IP isolation")
	}
	now = now.Add(30 * time.Second)
	l.result(loop6, now, false)
	if retry, _ := l.check(loop, now); retry != 60 {
		t.Fatal(retry)
	}
	for i := 0; i < 10; i++ {
		l.result(loop, now, false)
	}
	if retry, _ := l.check(loop, now); retry != 900 {
		t.Fatal(retry)
	}
	l.result(loop, now, true)
	if retry, _ := l.check(loop6, now); retry != 0 {
		t.Fatal("success reset")
	}
	l.result(lan, now, false)
	if retry, _ := l.check(lan, now.Add(10*time.Minute)); retry != 0 || len(l.ips) != 0 {
		t.Fatal("decay")
	}
	for i := 0; i < 51; i++ {
		l.result(lan, now, false)
	}
	if _, slow := l.check(remote, now); !slow {
		t.Fatal("global throttle")
	}
	if _, slow := l.check(remote, now.Add(10*time.Minute)); slow {
		t.Fatal("global decay")
	}
}

func TestIPv6RateLimitSharesSubnet(t *testing.T) {
	var limits limiter
	now := time.Now()
	for _, address := range []string{
		"2001:db8:1234:5678::1", "2001:db8:1234:5678::2", "2001:db8:1234:5678::3",
		"2001:db8:1234:5678::4", "2001:db8:1234:5678:ffff:ffff:ffff:ffff",
	} {
		limits.result(netip.MustParseAddr(address), now, false)
	}
	if retry, _ := limits.begin(netip.MustParseAddr("2001:db8:1234:5678::99"), now); retry != 30 {
		t.Fatalf("rotating interface addresses bypassed the subnet lock: %d", retry)
	}
	if retry, _ := limits.check(netip.MustParseAddr("2001:db8:1234:5679::1"), now); retry != 0 {
		t.Fatalf("adjacent /64 was locked: %d", retry)
	}
	limits.result(netip.MustParseAddr("2001:db8:1234:5678::99"), now, true)
	if retry, _ := limits.check(netip.MustParseAddr("2001:db8:1234:5678::1"), now); retry != 0 {
		t.Fatal("successful login did not reset the subnet bucket")
	}
	for i := 0; i < 5; i++ {
		limits.result(netip.MustParseAddr("::ffff:192.168.1.2"), now, false)
	}
	if retry, _ := limits.check(lan, now); retry != 30 {
		t.Fatal("IPv4-mapped address did not share the IPv4 bucket")
	}
	if retry, _ := limits.check(netip.MustParseAddr("192.168.1.3"), now); retry != 0 {
		t.Fatal("IPv4 addresses must keep independent buckets")
	}
}

func TestHashAdmissionAndCancellation(t *testing.T) {
	h := newHasher()
	for i := 0; i < 10; i++ {
		h.admitted <- struct{}{}
	}
	if _, e := h.encode(context.Background(), "password1"); !errors.Is(e, ErrBusy) {
		t.Fatal(e)
	}
	for i := 0; i < 10; i++ {
		<-h.admitted
	}
	h.slots <- struct{}{}
	h.slots <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e := h.encode(ctx, "password1"); !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
	if len(h.admitted) != 0 {
		t.Fatal("cancelled waiter leaked")
	}
}

func TestConcurrentSetupAndState(t *testing.T) {
	s := store(t)
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/__vim4/api/auth/state", nil)
	r.RemoteAddr = "127.0.0.1:1"
	s.Routes().ServeHTTP(w, r)
	var state map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &state)
	if state["configured"] != false || state["setupAllowed"] != false {
		t.Fatal(w.Body.String())
	}
	if _, e := s.Setup(context.Background(), remote, "test", "admin", "password1"); e == nil {
		t.Fatal("remote setup")
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, e := s.Setup(context.Background(), lan, "test", "admin", "password1")
			results <- e
		}()
	}
	close(start)
	wg.Wait()
	a, b := <-results, <-results
	if !((a == nil && errors.Is(b, ErrConfigured)) || (b == nil && errors.Is(a, ErrConfigured))) {
		t.Fatal(a, b)
	}
}

func TestRequestCancellationAndLoginErrors(t *testing.T) {
	s := store(t)
	token := setup(t, s)
	entered := make(chan struct{})
	done := make(chan struct{})
	handler := s.Require(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-r.Context().Done()
		close(done)
	}))
	r := httptest.NewRequest("GET", "/api/status", nil)
	r.RemoteAddr = "192.168.1.2:1"
	r.AddCookie(&http.Cookie{Name: CookieName, Value: token})
	go handler.ServeHTTP(httptest.NewRecorder(), r)
	<-entered
	s.Revoke(s.Authenticate(token, lan).ID, false)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("request not cancelled")
	}
	for i := 0; i < 5; i++ {
		_, e := s.Login(context.Background(), remote, "test", "not-admin", "wrong")
		if !errors.Is(e, ErrCredentials) {
			t.Fatal(e)
		}
	}
	_, e := s.Login(context.Background(), remote, "test", "admin", "password1")
	var locked *LockedError
	if !errors.As(e, &locked) {
		t.Fatal(e)
	}
	// A globally delayed attempt remains cancellable before hashing.
	for i := 0; i < 51; i++ {
		s.limits.result(lan, s.now(), false)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, e = s.Login(ctx, netip.MustParseAddr("8.8.8.8"), "test", "admin", "password1")
	if !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
}

func TestPasswordCommandAndRunningReload(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("command ownership requires the deployment khadas account")
	}
	s := store(t)
	token := setup(t, s)
	v := s.Authenticate(token, lan)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		s.Run(ctx)
		close(done)
	}()
	defer func() {
		cancel()
		<-done
	}()
	input, e := os.CreateTemp(t.TempDir(), "stdin")
	if e != nil {
		t.Fatal(e)
	}
	defer input.Close()
	input.WriteString("replacement-password\n")
	input.Seek(0, 0)
	var out bytes.Buffer
	if e = PasswordCommand([]string{"--state-dir", s.dir, "--username", "renamed"}, input, &out); e != nil {
		t.Fatal(e)
	}
	select {
	case <-v.ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("reset not reloaded within 2 seconds")
	}
	if _, e = s.Login(context.Background(), lan, "test", "renamed", "replacement-password"); e != nil {
		t.Fatal(e)
	}
}

func TestGlobalDelayAndLockedAttemptDecay(t *testing.T) {
	s := store(t)
	setup(t, s)
	for i := 0; i < 51; i++ {
		s.limits.result(lan, s.now(), false)
	}
	started := time.Now()
	if _, e := s.Login(context.Background(), remote, "test", "admin", "password1"); e != nil {
		t.Fatal(e)
	}
	if time.Since(started) < 5*time.Second {
		t.Fatal("global delay bypassed")
	}
	var l limiter
	now := time.Now()
	for i := 0; i < 10; i++ {
		l.result(lan, now, false)
	}
	if retry, _ := l.begin(lan, now.Add(9*time.Minute)); retry == 0 {
		t.Fatal("expected lock")
	}
	if retry, _ := l.check(lan, now.Add(11*time.Minute)); retry == 0 {
		t.Fatal("attempt during lock must prevent inactivity decay")
	}
	if retry, _ := l.check(lan, now.Add(19*time.Minute)); retry != 0 {
		t.Fatal("inactive bucket did not decay")
	}
}

func TestAuthHTTPFailuresAndCookie(t *testing.T) {
	s := store(t)
	setup(t, s)
	handler := s.Routes()
	login := func(username, password string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"username": username, "password": password})
		r := httptest.NewRequest("POST", "/__vim4/api/auth/login", bytes.NewReader(body))
		r.RemoteAddr = "127.0.0.1:1"
		r.Header.Set("X-Forwarded-Proto", "https")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	for i := 0; i < 5; i++ {
		if w := login("wrong", "password1"); w.Code != 401 {
			t.Fatal(w.Code)
		}
	}
	if w := login("admin", "password1"); w.Code != 429 || !strings.Contains(w.Body.String(), "retryAfter") {
		t.Fatal(w.Code, w.Body.String())
	}
	s.limits.result(netip.MustParseAddr("::1"), time.Now(), true)
	for i := 0; i < 10; i++ {
		s.hashes.admitted <- struct{}{}
	}
	if w := login("admin", "password1"); w.Code != 503 {
		t.Fatal(w.Code)
	}
	for i := 0; i < 10; i++ {
		<-s.hashes.admitted
	}
	w := login("admin", "password1")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	c := w.Result().Cookies()[0]
	if !c.Secure || !c.HttpOnly || c.MaxAge <= 0 {
		t.Fatal(c)
	}
	r := httptest.NewRequest("POST", "/__vim4/api/auth/logout", strings.NewReader("{}"))
	r.RemoteAddr = "127.0.0.1:1"
	r.AddCookie(c)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 200 || w.Result().Cookies()[0].MaxAge != -1 {
		t.Fatal(w.Code, w.Header())
	}
	if s.Authenticate(c.Value, lan) != nil {
		t.Fatal("logout retained session")
	}
}

package board

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"slices"
	"sync/atomic"
	"testing"
	"time"
)

func TestLocalHTTPSLifecycle(t *testing.T) {
	dir := t.TempDir()
	h, err := OpenHTTPS(dir, ":443", ":8443", nil)
	if err != nil {
		t.Fatal(err)
	}
	ca := h.CA()
	leaf := h.local
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(ca)
	if _, err := leaf.Leaf.Verify(x509.VerifyOptions{Roots: pool, DNSName: "localhost"}); err != nil {
		t.Fatal(err)
	}
	if !leaf.Leaf.NotAfter.After(time.Now().Add(396 * 24 * time.Hour)) {
		t.Fatal("leaf validity")
	}
	for _, file := range []string{"local-ca.key", "local-server.key"} {
		info, err := os.Stat(filepath.Join(dir, file))
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("key permissions: %v %v", info, err)
		}
	}
	reopened, err := OpenHTTPS(dir, ":443", ":8443", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(reopened.local.Certificate[0], leaf.Certificate[0]) {
		t.Fatal("leaf not reused")
	}
	names := append(h.Status(false).Local.Names, "192.0.2.2")
	h.inventory = func() ([]string, string, error) { return sortedHTTPSNames(names), "192.0.2.2", nil }
	if err = h.refreshLocal(time.Now()); err != nil {
		t.Fatal(err)
	}
	if slices.Equal(h.local.Certificate[0], leaf.Certificate[0]) || h.local.Leaf.VerifyHostname("192.0.2.2") != nil {
		t.Fatal("SAN change not reissued")
	}
	leaf = h.local
	if err = h.refreshLocal(time.Now().Add(368 * 24 * time.Hour)); err != nil {
		t.Fatal(err)
	}
	if slices.Equal(h.local.Certificate[0], leaf.Certificate[0]) || !slices.Equal(ca, h.CA()) {
		t.Fatal("expiry reissue must preserve CA")
	}
	if h.Status(false).URLs.Manager != "https://192.0.2.2" {
		t.Fatal(h.Status(false))
	}
	if err = h.SetHTTP(false); err != nil {
		t.Fatal(err)
	}
	reopened, err = OpenHTTPS(dir, ":443", ":8443", nil)
	if err != nil || reopened.HTTPEnabled() {
		t.Fatalf("persistence: %v", err)
	}
}

func TestHTTPSCertificateSelection(t *testing.T) {
	h, err := OpenHTTPS(t.TempDir(), ":443", ":8443", nil)
	if err != nil {
		t.Fatal(err)
	}
	cert, key, err := makeHTTPSCert(&x509.Certificate{DNSNames: []string{"box.example.ts.net"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(90 * 24 * time.Hour)}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	pair, err := tls.X509KeyPair(cert, key)
	if err != nil {
		t.Fatal(err)
	}
	pair.Leaf, _ = x509.ParseCertificate(pair.Certificate[0])
	h.tailscale = &pair
	for _, name := range []string{"box.example.ts.net", "BOX.EXAMPLE.TS.NET", "127.0.0.1", "", "localhost", "other.ts.net"} {
		got, _ := h.GetCertificate(&tls.ClientHelloInfo{ServerName: name})
		want := h.local
		if name == "box.example.ts.net" || name == "BOX.EXAMPLE.TS.NET" {
			want = &pair
		}
		if got != want {
			t.Fatalf("SNI %q", name)
		}
	}
}

func TestTailscaleHTTPSStates(t *testing.T) {
	h, err := OpenHTTPS(t.TempDir(), ":443", ":8443", nil)
	if err != nil {
		t.Fatal(err)
	}
	status := `{"BackendState":"Stopped"}`
	cert, key, err := makeHTTPSCert(&x509.Certificate{DNSNames: []string{"box.example.ts.net"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(90 * 24 * time.Hour)}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	started, release := make(chan struct{}), make(chan struct{})
	block := true
	calls := 0
	fail := false
	h.run = func(ctx context.Context, name string, args ...string) (string, error) {
		if name == "tailscale" {
			if !slices.Equal(args, []string{"status", "--json"}) {
				t.Error(args)
			}
			return status, nil
		}
		if !slices.Equal(args, []string{"-n", Helper, "tailscale-cert", "box.example.ts.net"}) {
			t.Error(args)
		}
		calls++
		if fail {
			return "", errors.New("denied")
		}
		if block {
			close(started)
			<-release
		}
		data, _ := json.Marshal(map[string]string{"cert": string(cert), "key": string(key)})
		return string(data), nil
	}
	h.refreshTailscale(context.Background(), false)
	if h.Status(false).Tailscale.State != "unavailable" {
		t.Fatal(h.Status(false))
	}
	status = `{"BackendState":"Running"}`
	h.refreshTailscale(context.Background(), false)
	if h.Status(false).Tailscale.State != "disabled" {
		t.Fatal(h.Status(false))
	}
	status = `{"BackendState":"Running","CertDomains":["box.example.ts.net"]}`
	done := make(chan struct{})
	go func() { h.refreshTailscale(context.Background(), false); close(done) }()
	<-started
	if h.Status(false).Tailscale.State != "pending" {
		t.Fatal(h.Status(false))
	}
	close(release)
	<-done
	if h.Status(false).Tailscale.State != "issued" {
		t.Fatal(h.Status(false))
	}
	h.refreshTailscale(context.Background(), false)
	if calls != 1 {
		t.Fatal("issued cert not reused")
	}
	// An expiring certificate stays available through renewal failures and
	// restart. Watch retries after a bounded delay; explicit retry bypasses it.
	now := time.Now()
	h.now = func() time.Time { return now }
	expiredCert, expiredKey, err := makeHTTPSCert(&x509.Certificate{DNSNames: []string{"box.example.ts.net"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(10 * 24 * time.Hour)}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = saveHTTPSPair(h.dir, "tailscale", expiredCert, expiredKey); err != nil {
		t.Fatal(err)
	}
	fail = true
	h.refreshTailscale(context.Background(), false)
	if h.Status(false).Tailscale.State != "error" || calls != 2 {
		t.Fatal(h.Status(false), calls)
	}
	assertCached := func(controller *HTTPS) {
		t.Helper()
		selected, err := controller.GetCertificate(&tls.ClientHelloInfo{ServerName: "box.example.ts.net"})
		if err != nil || !slices.Equal(selected.Certificate[0], mustParseHTTPSPair(t, expiredCert, expiredKey).Certificate[0]) {
			t.Fatal("valid expiring certificate was not selected", err)
		}
	}
	assertCached(h)
	h.refreshTailscale(context.Background(), false)
	if calls != 2 {
		t.Fatal(calls)
	}
	h.refreshTailscale(context.Background(), true)
	if calls != 3 {
		t.Fatal(calls)
	}
	now = now.Add(tailscaleCertRetryDelay - time.Second)
	h.refreshTailscale(context.Background(), false)
	if calls != 3 {
		t.Fatal("retried before backoff elapsed", calls)
	}
	now = now.Add(time.Second)
	h.refreshTailscale(context.Background(), false)
	if calls != 4 {
		t.Fatal("Watch did not retry after backoff", calls)
	}
	assertCached(h)
	restarted, err := OpenHTTPS(h.dir, ":443", ":8443", h.run)
	if err != nil {
		t.Fatal(err)
	}
	restarted.now = h.now
	assertCached(restarted)
	restarted.refreshTailscale(context.Background(), false)
	if restarted.Status(false).Tailscale.State != "error" || calls != 5 {
		t.Fatal(restarted.Status(false), calls)
	}
	assertCached(restarted)
	// The cached certificate is also served while a renewed request is pending.
	fail = false
	started, release = make(chan struct{}), make(chan struct{})
	done = make(chan struct{})
	go func() { restarted.refreshTailscale(context.Background(), true); close(done) }()
	<-started
	if restarted.Status(false).Tailscale.State != "pending" {
		t.Fatal(restarted.Status(false))
	}
	assertCached(restarted)
	close(release)
	<-done
	block = false
	if restarted.Status(false).Tailscale.State != "issued" {
		t.Fatal(restarted.Status(false))
	}
	selected, _ := restarted.GetCertificate(&tls.ClientHelloInfo{ServerName: "box.example.ts.net"})
	if !slices.Equal(selected.Certificate[0], mustParseHTTPSPair(t, cert, key).Certificate[0]) {
		t.Fatal("renewed certificate was not selected")
	}
	// A mismatched or expired cache must never be served for the requested name.
	for _, template := range []*x509.Certificate{
		{DNSNames: []string{"other.example.ts.net"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(10 * 24 * time.Hour)},
		{DNSNames: []string{"box.example.ts.net"}, NotBefore: time.Now().Add(-48 * time.Hour), NotAfter: time.Now().Add(-time.Hour)},
	} {
		badCert, badKey, err := makeHTTPSCert(template, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		if err = saveHTTPSPair(h.dir, "tailscale", badCert, badKey); err != nil {
			t.Fatal(err)
		}
		fail = true
		restarted.refreshTailscale(context.Background(), true)
		selected, _ := restarted.GetCertificate(&tls.ClientHelloInfo{ServerName: "box.example.ts.net"})
		if selected != restarted.local {
			t.Fatal("invalid cache was selected")
		}
	}
	status = "bad JSON"
	h.refreshTailscale(context.Background(), false)
	if h.Status(false).Tailscale.State != "unavailable" || h.tailscale != nil {
		t.Fatal(h.Status(false))
	}
}

func mustParseHTTPSPair(t *testing.T, cert, key []byte) tls.Certificate {
	t.Helper()
	pair, err := tls.X509KeyPair(cert, key)
	if err != nil {
		t.Fatal(err)
	}
	return pair
}

func TestHTTPSRefreshSingleFlight(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	h, err := OpenHTTPS(t.TempDir(), ":443", ":8443", func(ctx context.Context, name string, args ...string) (string, error) {
		if name == "tailscale" {
			return `{"BackendState":"Running","CertDomains":["box.example.ts.net"]}`, nil
		}
		calls.Add(1)
		close(started)
		<-release
		return "", errors.New("offline")
	})
	if err != nil {
		t.Fatal(err)
	}
	h.Refresh(context.Background(), false)
	<-started
	h.Refresh(context.Background(), false)
	h.Refresh(context.Background(), true)
	if calls.Load() != 1 {
		t.Fatal("overlapping certificate request")
	}
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for {
		h.mu.RLock()
		running := h.refreshing
		h.mu.RUnlock()
		if !running {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("refresh did not finish")
		}
		time.Sleep(time.Millisecond)
	}
	if h.Status(false).Tailscale.State != "error" {
		t.Fatal(h.Status(false))
	}
}

func TestLocalHTTPSNames(t *testing.T) {
	names, _, err := localHTTPSNames()
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"localhost", "127.0.0.1", "::1"} {
		if !slices.Contains(names, required) {
			t.Fatal(names)
		}
	}
	for _, name := range names {
		if ip := net.ParseIP(name); ip != nil && ip.IsLinkLocalUnicast() {
			t.Fatal(names)
		}
	}
}

func TestHTTPSAccessURLsUseListenerPorts(t *testing.T) {
	for _, test := range []struct{ name, managerListen, kvmListen, managerURL, kvmURL string }{
		{"defaults", ":443", ":8443", "https://192.0.2.2", "https://192.0.2.2:8443"},
		{"custom", "127.0.0.1:9443", ":18443", "https://192.0.2.2:9443", "https://192.0.2.2:18443"},
	} {
		t.Run(test.name, func(t *testing.T) {
			h, err := OpenHTTPS(t.TempDir(), test.managerListen, test.kvmListen, nil)
			if err != nil {
				t.Fatal(err)
			}
			h.inventory = func() ([]string, string, error) { return []string{"192.0.2.2", "localhost"}, "192.0.2.2", nil }
			// Watch refreshes must keep the configured ports when updating LAN URLs.
			if err := h.refreshLocal(time.Now()); err != nil {
				t.Fatal(err)
			}
			urls := h.Status(true).URLs
			if urls.Manager != test.managerURL || urls.KVM != test.kvmURL {
				t.Fatalf("URLs: %+v", urls)
			}
		})
	}
}

func TestHTTPSWatchReloadsRecoverySetting(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	dir := t.TempDir()
	certStarted := make(chan struct{})
	h, err := OpenHTTPS(dir, ":443", ":8443", func(ctx context.Context, name string, args ...string) (string, error) {
		if name == "tailscale" {
			return `{"BackendState":"Running","CertDomains":["box.example.ts.net"]}`, nil
		}
		close(certStarted)
		<-ctx.Done()
		return "", ctx.Err()
	})
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if err = h.SetHTTP(false); err != nil {
		cancel()
		t.Fatal(err)
	}
	// Pause snapshots at the command boundary to coordinate external writes
	// between ticks, while certificate issuance stays pending for the whole test.
	ticks, advance := make(chan struct{}), make(chan struct{})
	s := &Service{HTTPS: h, Events: &Events{Capacity: 10},
		Passthrough: &Passthrough{provider: &fakePassthroughProvider{}},
		Run: func(ctx context.Context, _ string, _ ...string) (string, error) {
			select {
			case ticks <- struct{}{}:
			case <-ctx.Done():
				return "", ctx.Err()
			}
			select {
			case <-advance:
			case <-ctx.Done():
			}
			return "", errors.New("skip hardware snapshot")
		},
	}
	done := make(chan struct{})
	go func() { defer close(done); s.Watch(ctx, time.Millisecond) }()
	defer func() { cancel(); <-done }()
	waitTick := func() {
		t.Helper()
		select {
		case <-ticks:
		case <-time.After(5 * time.Second):
			t.Fatal("Watch did not reach next tick")
		}
	}
	waitTick()
	select {
	case <-certStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("certificate request did not start")
	}
	for _, enabled := range []bool{true, false} {
		if err := WriteHTTPSetting(dir, enabled); err != nil {
			t.Fatal(err)
		}
		advance <- struct{}{}
		waitTick()
		if h.HTTPEnabled() != enabled || h.Status(false).HTTPEnabled != enabled {
			t.Fatal("Watch did not reload recovery preference", enabled)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "https.json"), []byte("invalid JSON"), 0600); err != nil {
		t.Fatal(err)
	}
	advance <- struct{}{}
	waitTick()
	if h.HTTPEnabled() {
		t.Fatal("invalid preference replaced last valid setting")
	}
	if err := WriteHTTPSetting(dir, true); err != nil {
		t.Fatal(err)
	}
	advance <- struct{}{}
	waitTick()
	if !h.HTTPEnabled() {
		t.Fatal("Watch did not recover after invalid preference")
	}
}

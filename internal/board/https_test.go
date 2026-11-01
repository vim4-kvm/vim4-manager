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
	"testing"
	"time"
)

func TestLocalHTTPSLifecycle(t *testing.T) {
	dir := t.TempDir()
	h, err := OpenHTTPS(dir, nil)
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
	reopened, err := OpenHTTPS(dir, nil)
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
	reopened, err = OpenHTTPS(dir, nil)
	if err != nil || reopened.HTTPEnabled() {
		t.Fatalf("persistence: %v", err)
	}
}

func TestHTTPSCertificateSelection(t *testing.T) {
	h, err := OpenHTTPS(t.TempDir(), nil)
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
	h, err := OpenHTTPS(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	status := `{"BackendState":"Stopped"}`
	cert, key, err := makeHTTPSCert(&x509.Certificate{DNSNames: []string{"box.example.ts.net"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(90 * 24 * time.Hour)}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	started, release := make(chan struct{}), make(chan struct{})
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
		close(started)
		<-release
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
	// An expiring certificate is renewed; failed renewals are exposed and wait
	// for an explicit retry rather than hammering tailscaled every watch tick.
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
	h.refreshTailscale(context.Background(), false)
	if calls != 2 {
		t.Fatal(calls)
	}
	h.refreshTailscale(context.Background(), true)
	if calls != 3 {
		t.Fatal(calls)
	}
	status = "bad JSON"
	h.refreshTailscale(context.Background(), false)
	if h.Status(false).Tailscale.State != "unavailable" || h.tailscale != nil {
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

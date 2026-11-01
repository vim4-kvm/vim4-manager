package board

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/statefile"
)

type HTTPSLocal struct {
	Names       []string  `json:"names"`
	NotAfter    time.Time `json:"not_after"`
	Fingerprint string    `json:"fingerprint_sha256"`
}
type HTTPSCertificate struct {
	State    string     `json:"state"`
	Name     string     `json:"name,omitempty"`
	NotAfter *time.Time `json:"not_after,omitempty"`
	Error    string     `json:"error,omitempty"`
}
type HTTPSState struct {
	HTTPEnabled   bool `json:"http_enabled"`
	RequestSecure bool `json:"request_secure"`
	URLs          struct {
		Manager string `json:"manager"`
		KVM     string `json:"kvm"`
	} `json:"urls"`
	Local     HTTPSLocal       `json:"local"`
	Tailscale HTTPSCertificate `json:"tailscale"`
}

// HTTPS owns the certificates shared by both TLS listeners. Refresh runs from
// the existing board watch; certificate requests never block status readers.
type HTTPS struct {
	mu               sync.RWMutex
	refreshing       bool
	dir              string
	run              Runner
	inventory        func() ([]string, string, error)
	local, tailscale *tls.Certificate
	caPEM            []byte
	state            HTTPSState
}

func readHTTPSetting(dir string) (bool, error) {
	prefs := struct {
		Enabled bool `json:"http_enabled"`
	}{true}
	data, err := os.ReadFile(filepath.Join(dir, "https.json"))
	if os.IsNotExist(err) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	err = json.Unmarshal(data, &prefs)
	return prefs.Enabled, err
}

func WriteHTTPSetting(dir string, enabled bool) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	return statefile.WriteJSON(filepath.Join(dir, "https.json"), struct {
		Enabled bool `json:"http_enabled"`
	}{enabled})
}

func OpenHTTPS(dir string, run Runner) (*HTTPS, error) {
	if run == nil {
		run = Exec
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	enabled, err := readHTTPSetting(dir)
	if err != nil {
		return nil, err
	}
	h := &HTTPS{dir: dir, run: run, inventory: localHTTPSNames}
	h.state.HTTPEnabled = enabled
	h.state.Tailscale.State = "unavailable"
	if err := h.refreshLocal(time.Now()); err != nil {
		return nil, err
	}
	return h, nil
}

func localHTTPSNames() ([]string, string, error) {
	hostname, err := os.Hostname()
	if err != nil {
		return nil, "", err
	}
	names := []string{hostname, hostname + ".local", "localhost", "127.0.0.1", "::1"}
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil, "", err
	}
	primary, wifi := "", ""
	for _, iface := range interfaces {
		addresses, err := iface.Addrs()
		if err != nil {
			return nil, "", err
		}
		for _, address := range addresses {
			ip, _, err := net.ParseCIDR(address.String())
			if err != nil || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
				continue
			}
			names = append(names, ip.String())
			if ip.To4() != nil {
				if iface.Name == "eth0" && primary == "" {
					primary = ip.String()
				}
				if iface.Name == "wlan0" && wifi == "" {
					wifi = ip.String()
				}
			}
		}
	}
	if primary == "" {
		primary = wifi
	}
	if primary == "" {
		primary = "127.0.0.1"
	}
	return sortedHTTPSNames(names), primary, nil
}

func sortedHTTPSNames(names []string) []string {
	slices.SortFunc(names, func(a, b string) int {
		rank := func(s string) int {
			ip := net.ParseIP(s)
			if ip == nil {
				return 1
			}
			if ip.To4() != nil {
				return 0
			}
			return 2
		}
		if d := rank(a) - rank(b); d != 0 {
			return d
		}
		return strings.Compare(a, b)
	})
	return slices.Compact(names)
}

func makeHTTPSCert(template, parent *x509.Certificate, signer any) ([]byte, []byte, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	template.SerialNumber, err = rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, nil, err
	}
	if parent == nil {
		parent, signer = template, key
	}
	der, err := x509.CreateCertificate(rand.Reader, template, parent, &key.PublicKey, signer)
	if err != nil {
		return nil, nil, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), nil
}

func saveHTTPSPair(dir, name string, cert, key []byte) error {
	if err := os.WriteFile(filepath.Join(dir, name+".key"), key, 0600); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, name+".crt"), cert, 0644)
}

func loadHTTPSPair(dir, name string) (*tls.Certificate, error) {
	cert, err := tls.LoadX509KeyPair(filepath.Join(dir, name+".crt"), filepath.Join(dir, name+".key"))
	if err != nil {
		return nil, err
	}
	cert.Leaf, err = x509.ParseCertificate(cert.Certificate[0])
	return &cert, err
}

func (h *HTTPS) refreshLocal(now time.Time) error {
	names, primary, err := h.inventory()
	if err != nil {
		return err
	}
	ca, err := loadHTTPSPair(h.dir, "local-ca")
	if err != nil {
		// Never silently replace an established trust anchor when its key is damaged.
		if _, statErr := os.Stat(filepath.Join(h.dir, "local-ca.crt")); !os.IsNotExist(statErr) {
			return fmt.Errorf("load local CA: %w", err)
		}
		hostname, _ := os.Hostname()
		cert, key, err := makeHTTPSCert(&x509.Certificate{Subject: pkix.Name{CommonName: "VIM4 KVM Local CA " + hostname}, NotBefore: now.Add(-time.Hour), NotAfter: now.AddDate(10, 0, 0), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}, nil, nil)
		if err != nil {
			return err
		}
		if err = saveHTTPSPair(h.dir, "local-ca", cert, key); err != nil {
			return err
		}
		ca, err = loadHTTPSPair(h.dir, "local-ca")
		if err != nil {
			return err
		}
	}
	leaf, err := loadHTTPSPair(h.dir, "local-server")
	reissue := err != nil
	if !reissue {
		oldNames := append([]string{}, leaf.Leaf.DNSNames...)
		for _, ip := range leaf.Leaf.IPAddresses {
			oldNames = append(oldNames, ip.String())
		}
		reissue = leaf.Leaf.NotAfter.Before(now.Add(30*24*time.Hour)) || !slices.Equal(sortedHTTPSNames(oldNames), names) || leaf.Leaf.CheckSignatureFrom(ca.Leaf) != nil
	}
	if reissue {
		template := &x509.Certificate{NotBefore: now.Add(-time.Hour), NotAfter: now.Add(397 * 24 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
		for _, name := range names {
			if ip := net.ParseIP(name); ip != nil {
				template.IPAddresses = append(template.IPAddresses, ip)
			} else {
				template.DNSNames = append(template.DNSNames, name)
			}
		}
		cert, key, err := makeHTTPSCert(template, ca.Leaf, ca.PrivateKey)
		if err != nil {
			return err
		}
		if err = saveHTTPSPair(h.dir, "local-server", cert, key); err != nil {
			return err
		}
		leaf, err = loadHTTPSPair(h.dir, "local-server")
		if err != nil {
			return err
		}
	}
	caPEM, err := os.ReadFile(filepath.Join(h.dir, "local-ca.crt"))
	if err != nil {
		return err
	}
	sum := sha256.Sum256(ca.Leaf.Raw)
	parts := make([]string, len(sum))
	for i, b := range sum {
		parts[i] = fmt.Sprintf("%02X", b)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.local, h.caPEM = leaf, caPEM
	h.state.Local = HTTPSLocal{names, leaf.Leaf.NotAfter, strings.Join(parts, ":")}
	h.state.URLs.Manager = "https://" + primary
	h.state.URLs.KVM = "https://" + primary + ":8443"
	return nil
}

func (h *HTTPS) Status(secure bool) HTTPSState {
	h.mu.RLock()
	defer h.mu.RUnlock()
	state := h.state
	state.RequestSecure = secure
	state.Local.Names = slices.Clone(state.Local.Names)
	return state
}
func (h *HTTPS) CA() []byte        { h.mu.RLock(); defer h.mu.RUnlock(); return slices.Clone(h.caPEM) }
func (h *HTTPS) HTTPEnabled() bool { h.mu.RLock(); defer h.mu.RUnlock(); return h.state.HTTPEnabled }
func (h *HTTPS) SetHTTP(enabled bool) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := WriteHTTPSetting(h.dir, enabled); err != nil {
		return err
	}
	h.state.HTTPEnabled = enabled
	return nil
}
func (h *HTTPS) GetCertificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	name := strings.ToLower(strings.TrimSuffix(hello.ServerName, "."))
	if h.tailscale != nil && strings.HasSuffix(name, ".ts.net") && h.tailscale.Leaf.VerifyHostname(name) == nil {
		return h.tailscale, nil
	}
	return h.local, nil
}

func (h *HTTPS) Refresh(ctx context.Context, retry bool) {
	h.mu.Lock()
	if h.refreshing {
		h.mu.Unlock()
		return
	}
	h.refreshing = true
	h.mu.Unlock()
	go func() {
		defer func() { h.mu.Lock(); h.refreshing = false; h.mu.Unlock() }()
		if err := h.refreshLocal(time.Now()); err != nil {
			slog.Error("refresh HTTPS certificate", "error", err)
		}
		h.refreshTailscale(ctx, retry)
	}()
}

func (h *HTTPS) refreshTailscale(ctx context.Context, retry bool) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	output, err := h.run(ctx, "tailscale", "status", "--json")
	var status struct {
		BackendState string
		CertDomains  []string
	}
	if err != nil || json.Unmarshal([]byte(output), &status) != nil || status.BackendState != "Running" {
		h.mu.Lock()
		h.state.Tailscale = HTTPSCertificate{State: "unavailable"}
		h.tailscale = nil
		h.mu.Unlock()
		return
	}
	if len(status.CertDomains) == 0 {
		h.mu.Lock()
		h.state.Tailscale = HTTPSCertificate{State: "disabled"}
		h.tailscale = nil
		h.mu.Unlock()
		return
	}
	name := strings.TrimSuffix(status.CertDomains[0], ".")
	h.mu.RLock()
	previous := h.state.Tailscale
	h.mu.RUnlock()
	if !retry && previous.State == "error" && previous.Name == name {
		return
	}
	cert, err := loadHTTPSPair(h.dir, "tailscale")
	if err == nil && cert.Leaf.VerifyHostname(name) == nil && cert.Leaf.NotAfter.After(time.Now().Add(30*24*time.Hour)) {
		h.mu.Lock()
		h.tailscale = cert
		h.state.Tailscale = HTTPSCertificate{State: "issued", Name: name, NotAfter: &cert.Leaf.NotAfter}
		h.mu.Unlock()
		return
	}
	h.mu.Lock()
	h.state.Tailscale = HTTPSCertificate{State: "pending", Name: name}
	h.mu.Unlock()
	output, err = h.run(ctx, "sudo", "-n", Helper, "tailscale-cert", name)
	var pair struct {
		Cert string `json:"cert"`
		Key  string `json:"key"`
	}
	if err == nil {
		err = json.Unmarshal([]byte(output), &pair)
	}
	if err == nil {
		var parsed tls.Certificate
		parsed, err = tls.X509KeyPair([]byte(pair.Cert), []byte(pair.Key))
		if err == nil {
			parsed.Leaf, err = x509.ParseCertificate(parsed.Certificate[0])
		}
		if err == nil {
			err = parsed.Leaf.VerifyHostname(name)
		}
		if err == nil {
			err = saveHTTPSPair(h.dir, "tailscale", []byte(pair.Cert), []byte(pair.Key))
			cert = &parsed
		}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if err != nil {
		h.state.Tailscale = HTTPSCertificate{State: "error", Name: name, Error: "Couldn't obtain Tailscale certificate. Check Tailscale HTTPS settings and retry."}
		return
	}
	h.tailscale = cert
	h.state.Tailscale = HTTPSCertificate{State: "issued", Name: name, NotAfter: &cert.Leaf.NotAfter}
}

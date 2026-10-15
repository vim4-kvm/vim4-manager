package board

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewerVersionComparesNumerically(t *testing.T) {
	for _, c := range []struct {
		candidate, current string
		newer              bool
	}{
		{"2.5.1+vim4.20261016.10", "2.5.1+vim4.20261016.9", true},
		{"2.5.1+vim4.20261016.1", "2.5.1+vim4.20261015.99", true},
		{"2.5.1+vim4.20261015.62", "2.5.1+vim4.20261015.62", false},
		{"2.5.0+vim4.20261020.1", "2.5.1+vim4.20261015.1", false},
		{"2.5.1+vim4.20261016.1", "0.1.0~dev4", true},
	} {
		if newer, err := newerVersion(c.candidate, c.current); err != nil || newer != c.newer {
			t.Errorf("newerVersion(%q, %q) = %v, %v", c.candidate, c.current, newer, err)
		}
	}
	if _, err := newerVersion("latest", "2.5.1+vim4.20261016.1"); err == nil {
		t.Error("accepted an invalid release version")
	}
}

// github serves release assets for the test; the transport redirects every
// request to it while preserving the GitHub path.
func github(t *testing.T, assets map[string][]byte) *Updater {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, ok := assets[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(server.Close)
	target, _ := url.Parse(server.URL)
	transport := roundTripper(func(r *http.Request) (*http.Response, error) {
		r = r.Clone(r.Context())
		r.URL.Scheme, r.URL.Host = target.Scheme, target.Host
		return http.DefaultTransport.RoundTrip(r)
	})
	return &Updater{Client: &http.Client{Transport: transport}, Dir: t.TempDir()}
}

type roundTripper func(*http.Request) (*http.Response, error)

func (f roundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func releaseAssets(pkg, repo, version string, deb []byte, tamper func(*Release)) map[string][]byte {
	sum := sha256.Sum256(deb)
	name := pkg + "_" + version + "_arm64.deb"
	release := Release{Package: pkg, Version: version, SHA256: hex.EncodeToString(sum[:]), Size: int64(len(deb)),
		URL: "https://github.com/vim4-kvm/" + repo + "/releases/download/" + version + "/" + name}
	if tamper != nil {
		tamper(&release)
	}
	manifest, _ := json.Marshal(release)
	return map[string][]byte{
		"/vim4-kvm/" + repo + "/releases/latest/download/" + pkg + "-latest.json": manifest,
		"/vim4-kvm/" + repo + "/releases/download/" + version + "/" + name:        deb,
	}
}

func updateService(t *testing.T, updater *Updater, calls *[]string) *Service {
	root := t.TempDir()
	status := "Package: vim4-pikvm\nStatus: install ok installed\nVersion: 2.5.1+vim4.20261015.63\n\n" +
		"Package: vim4-nanokvm\nStatus: install ok installed\nVersion: 2.5.1+vim4.20261015.62\n"
	if err := os.MkdirAll(filepath.Join(root, "var/lib/dpkg"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "var/lib/dpkg/status"), []byte(status), 0o644); err != nil {
		t.Fatal(err)
	}
	return &Service{Root: root, Updater: updater, Events: &Events{Capacity: 10},
		Run: func(_ context.Context, name string, args ...string) (string, error) {
			*calls = append(*calls, name+" "+strings.Join(args, " "))
			return "", nil
		}}
}

func TestUpdateDownloadsVerifiedPackageForHelper(t *testing.T) {
	deb := []byte("pikvm package")
	updater := github(t, releaseAssets("vim4-pikvm", "kvmd", "2.5.1+vim4.20261016.1", deb, nil))
	var calls []string
	s := updateService(t, updater, &calls)
	updates := s.Updates(context.Background())
	if updates[3].Package != "vim4-pikvm" || !updates[3].Available || updates[3].Latest != "2.5.1+vim4.20261016.1" {
		t.Fatalf("PiKVM update = %+v", updates[3])
	}
	if updates[1].Installed != "" || updates[1].Error != "" {
		t.Errorf("uninstalled JetKVM must not be checked: %+v", updates[1])
	}
	if err := s.Update(context.Background(), "vim4-pikvm"); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(deb)
	want := "sudo -n " + Helper + " update vim4-pikvm " + hex.EncodeToString(sum[:]) + " 2.5.1+vim4.20261016.1"
	if len(calls) != 1 || calls[0] != want {
		t.Fatalf("helper calls = %q", calls)
	}
	if data, _ := os.ReadFile(filepath.Join(updater.Dir, "vim4-pikvm.deb")); string(data) != string(deb) {
		t.Errorf("downloaded package = %q", data)
	}
}

func TestUpdateRejectsUnsafeReleases(t *testing.T) {
	for name, c := range map[string]struct {
		pkg    string
		tamper func(*Release)
	}{
		"checksum":    {"vim4-pikvm", func(r *Release) { r.SHA256 = strings.Repeat("0", 64) }},
		"size":        {"vim4-pikvm", func(r *Release) { r.Size++ }},
		"other host":  {"vim4-pikvm", func(r *Release) { r.URL = "https://example.com/vim4-pikvm.deb" }},
		"other repo":  {"vim4-pikvm", func(r *Release) { r.URL = strings.Replace(r.URL, "/kvmd/", "/One-KVM/", 1) }},
		"not newer":   {"vim4-pikvm", func(r *Release) { r.Version = "2.5.1+vim4.20261015.63" }},
		"other name":  {"vim4-pikvm", func(r *Release) { r.Package = "vim4-manager" }},
		"self update": {"vim4-nanokvm", nil},
	} {
		t.Run(name, func(t *testing.T) {
			repo := map[string]string{"vim4-pikvm": "kvmd", "vim4-nanokvm": "NanoKVM"}[c.pkg]
			updater := github(t, releaseAssets(c.pkg, repo, "2.5.1+vim4.20261016.1", []byte("package"), c.tamper))
			var calls []string
			if err := updateService(t, updater, &calls).Update(context.Background(), c.pkg); err == nil {
				t.Fatal("unsafe release accepted")
			}
			if len(calls) != 0 {
				t.Fatalf("helper called: %q", calls)
			}
		})
	}
}

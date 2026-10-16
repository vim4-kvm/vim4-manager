package board

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"sync"
	"time"
)

// Update describes one independently released package.
type Update struct {
	Package   string `json:"package"`
	Name      string `json:"name"`
	Repo      string `json:"repo"`
	Installed string `json:"installed"`
	Latest    string `json:"latest,omitempty"`
	Available bool   `json:"available"`
	// SelfService packages have their own web updater; the dashboard links to it.
	SelfService bool   `json:"selfService"`
	Error       string `json:"error,omitempty"`
}

// Release is the <package>-latest.json asset of a GitHub release.
type Release struct {
	Package string `json:"package"`
	Version string `json:"version"`
	URL     string `json:"url"`
	SHA256  string `json:"sha256"`
	Size    int64  `json:"size"`
}

// Released is a package published by its own GitHub repository.
type Released struct {
	Package, Name, Repo string
	SelfService         bool
}

// Updatable lists the released packages in display order. Repo names match
// the GitHub repositories whose latest release carries the package.
var Updatable = []Released{
	{"vim4-nanokvm", "NanoKVM", "NanoKVM", true},
	{"vim4-jetkvm", "JetKVM", "kvm", true},
	{"vim4-onekvm", "One-KVM", "One-KVM", true},
	{"vim4-pikvm", "PiKVM", "kvmd", false},
	{"vim4-manager", "管理面板", "vim4-manager", false},
}

// UpdateDir is where the unprivileged manager downloads packages; the root
// helper reads <package>.deb from here.
const UpdateDir = "/var/lib/vim4-manager/updates"

const maxUpdateSize = 256 << 20

var (
	versionPattern = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)\+vim4\.(\d{8})\.(\d+)$`)
	// Development builds append .dev.N.g<commit>[.dirty] to the release they started from.
	developmentPattern = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)\+vim4\.(\d{8})\.(\d+)\.dev\.\d+\.g[0-9a-f]{7,40}(?:\.dirty)?$`)
	digestPattern      = regexp.MustCompile(`^[0-9a-f]{64}$`)
	releaseBase        = "https://github.com/vim4-kvm/%s/releases/latest/download/%s-latest.json"
)

// Updater checks GitHub releases and downloads packages for the helper.
type Updater struct {
	Client *http.Client
	Dir    string
	mu     sync.Mutex
}

// newerVersion orders x.y.z+vim4.YYYYMMDD.N releases numerically. An installed
// development build counts as newer than its base release and older than the next.
func newerVersion(candidate, current string) (bool, error) {
	a, b := versionPattern.FindStringSubmatch(candidate), versionPattern.FindStringSubmatch(current)
	if a == nil {
		return false, fmt.Errorf("版本格式无效：%s", candidate)
	}
	if b == nil {
		b = developmentPattern.FindStringSubmatch(current)
	}
	if b == nil {
		// Older development builds use other formats; any release replaces them.
		return true, nil
	}
	for i := 1; i < len(a); i++ {
		x, _ := strconv.ParseUint(a[i], 10, 64)
		y, _ := strconv.ParseUint(b[i], 10, 64)
		if x != y {
			return x > y, nil
		}
	}
	return false, nil
}

func (u *Updater) latest(ctx context.Context, repo, pkg string) (Release, error) {
	var release Release
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf(releaseBase, repo, pkg), nil)
	if err != nil {
		return release, err
	}
	response, err := u.Client.Do(request)
	if err != nil {
		return release, errors.New("无法连接 GitHub")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return release, errors.New("尚未发布")
	}
	if response.StatusCode != http.StatusOK {
		return release, fmt.Errorf("GitHub 返回 %d", response.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&release); err != nil {
		return release, errors.New("发布信息格式错误")
	}
	asset, err := url.Parse(release.URL)
	expectedPath := fmt.Sprintf("/vim4-kvm/%s/releases/download/%s/%s_%s_arm64.deb", repo, release.Version, pkg, release.Version)
	if err != nil || asset.Scheme != "https" || asset.Host != "github.com" || asset.User != nil ||
		asset.Path != expectedPath || asset.RawQuery != "" || asset.Fragment != "" ||
		release.Package != pkg || !versionPattern.MatchString(release.Version) || !digestPattern.MatchString(release.SHA256) ||
		release.Size <= 0 || release.Size > maxUpdateSize {
		return release, errors.New("发布信息无效")
	}
	return release, nil
}

// Updates reports installed and latest versions for every released package.
func (s *Service) Updates(ctx context.Context) []Update {
	installed := map[string]string{}
	for _, p := range s.installed() {
		installed[p.Name] = p.Version
	}
	updates := make([]Update, len(Updatable))
	var wg sync.WaitGroup
	for i, item := range Updatable {
		updates[i] = Update{Package: item.Package, Name: item.Name, Repo: item.Repo,
			Installed: installed[item.Package], SelfService: item.SelfService}
		if updates[i].Installed == "" {
			continue
		}
		wg.Add(1)
		go func(update *Update) {
			defer wg.Done()
			release, err := s.Updater.latest(ctx, update.Repo, update.Package)
			if err != nil {
				update.Error = err.Error()
				return
			}
			update.Latest = release.Version
			update.Available, err = newerVersion(release.Version, update.Installed)
			if err != nil {
				update.Error = err.Error()
			}
		}(&updates[i])
	}
	wg.Wait()
	return updates
}

// Update downloads the latest release of pkg, verifies it and installs it
// through the helper. Packages with their own updater are refused.
func (s *Service) Update(ctx context.Context, pkg string) error {
	index := slices.IndexFunc(Updatable, func(item Released) bool { return item.Package == pkg })
	if index < 0 || Updatable[index].SelfService {
		return fmt.Errorf("%s 请在其自身界面中更新", pkg)
	}
	if !s.Updater.mu.TryLock() {
		return ErrBusy
	}
	defer s.Updater.mu.Unlock()
	installed := ""
	for _, p := range s.installed() {
		if p.Name == pkg {
			installed = p.Version
		}
	}
	if installed == "" {
		return fmt.Errorf("%s 未安装", pkg)
	}
	release, err := s.Updater.latest(ctx, Updatable[index].Repo, pkg)
	if err != nil {
		return err
	}
	if newer, err := newerVersion(release.Version, installed); err != nil || !newer {
		return errors.New("已是最新版本")
	}
	if err := s.Updater.download(ctx, release); err != nil {
		return err
	}
	// Installation continues if the browser disconnects.
	ctx = context.WithoutCancel(ctx)
	return s.record(s.helper(ctx, "update", pkg, release.SHA256, release.Version), "更新 %s 至 %s", Updatable[index].Name, release.Version)
}

func (u *Updater) download(ctx context.Context, release Release) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, release.URL, nil)
	if err != nil {
		return err
	}
	response, err := u.Client.Do(request)
	if err != nil {
		return errors.New("下载失败")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("下载失败：HTTP %d", response.StatusCode)
	}
	if err := os.MkdirAll(u.Dir, 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(u.Dir, ".download-*")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(temporary, hash), io.LimitReader(response.Body, release.Size+1))
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return errors.New("下载中断")
	}
	if written != release.Size || hex.EncodeToString(hash.Sum(nil)) != release.SHA256 {
		return errors.New("下载的安装包校验失败")
	}
	return os.Rename(temporary.Name(), filepath.Join(u.Dir, release.Package+".deb"))
}

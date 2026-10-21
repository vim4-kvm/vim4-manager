package board

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Helper is the root helper invoked through a sudoers rule.
const Helper = "/usr/libexec/vim4-manager-helper"

// ErrBusy means another operation in the same subsystem is still running.
var ErrBusy = errors.New("另一项操作正在进行")

// Service answers dashboard queries and serializes privileged operations.
type Service struct {
	Run        Runner
	Stream     StreamRunner
	Root       string
	History    *History
	Events     *Events
	Updater    *Updater
	mu         sync.Mutex
	powerMu    sync.Mutex
	powerAt    time.Time
	powerState Power

	tailscaleMu       sync.Mutex
	tailscaleJob      *TailscaleJob
	tailscalePingOnce sync.Once
	tailscalePings    chan struct{}
	TailscaleHTTP     *http.Client
	tailscaleReadMu   sync.Mutex
	tailscaleReadAt   time.Time
	tailscaleState    TailscaleState

	pkgMu    sync.Mutex
	pkgMtime time.Time
	packages []Package
}

// Status is the complete dashboard state.
type Status struct {
	Power    Power      `json:"power"`
	Media    Media      `json:"media"`
	Active   string     `json:"active"`
	Apps     []AppState `json:"apps"`
	Platform []Platform `json:"platform"`
	Hardware Hardware   `json:"hardware"`
	System   System     `json:"system"`
	History  []Sample   `json:"history"`
	Events   []Event    `json:"events"`
}

// System is the network, storage and software summary on the overview.
type System struct {
	Links    []Link    `json:"links"`
	Disk     Disk      `json:"disk"`
	Packages []Package `json:"packages"`
}

// AppState combines an App with its systemd unit.
type AppState struct {
	App
	Unit Unit `json:"unit"`
}

// Platform is a shared board service.
type Platform struct {
	Name        string `json:"name"`
	Unit        Unit   `json:"unit"`
	Restartable bool   `json:"restartable"`
}

func allUnits() []string {
	names := make([]string, 0, len(Apps)+len(PlatformUnits))
	for _, app := range Apps {
		names = append(names, app.Unit)
	}
	for _, p := range PlatformUnits {
		names = append(names, p.Unit)
	}
	return names
}

// Status reads systemd and hardware state.
func (s *Service) Status(ctx context.Context) (Status, error) {
	units, err := QueryUnits(ctx, s.Run, allUnits())
	if err != nil {
		return Status{}, err
	}
	status := Status{Hardware: ReadHardware(s.Root), History: []Sample{}, Events: s.Events.List(), Media: s.media(ctx)}
	if strings.HasPrefix(status.Hardware.Kernel, "7.") {
		probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		data, err := s.Run(probeCtx, "sudo", "-n", Helper, "mainline-hardware")
		cancel()
		if err == nil {
			_ = json.Unmarshal([]byte(data), &status.Hardware.HDMI)
		}
	}
	status.Power = s.power(ctx)
	if s.History != nil {
		status.History = s.History.Samples()
	}
	// Addresses are optional detail; a failing ip call must not hide the rest.
	addrs, _ := s.Run(ctx, "ip", "-o", "addr", "show")
	status.System = System{Links: readLinks(s.Root, parseAddrs(addrs)), Disk: readDisk(s.Root), Packages: s.installed()}
	for _, app := range Apps {
		unit := units[app.Unit]
		status.Apps = append(status.Apps, AppState{App: app, Unit: unit})
		// The selection is what boots; an enabled app that has failed is
		// still the selected one and is shown as failed, not as unselected.
		if unit.Enabled == "enabled" {
			status.Active = app.ID
		}
	}
	for _, p := range PlatformUnits {
		status.Platform = append(status.Platform, Platform{Name: p.Name, Unit: units[p.Unit], Restartable: Restartable(p.Unit)})
	}
	return status, nil
}

// installed caches the dpkg database parse until the file changes.
func (s *Service) installed() []Package {
	path := filepath.Join(s.Root, "var/lib/dpkg/status")
	info, err := os.Stat(path)
	if err != nil {
		return []Package{}
	}
	s.pkgMu.Lock()
	defer s.pkgMu.Unlock()
	if !info.ModTime().Equal(s.pkgMtime) {
		data, _ := os.ReadFile(path)
		s.packages, s.pkgMtime = installedPackages(string(data)), info.ModTime()
	}
	return s.packages
}

// Restartable reports whether the dashboard may restart unit. Gadget rebinds
// and PD renegotiation can drop the host USB link; those stay with the board tools.
func Restartable(unit string) bool {
	return unit == "vim4-kvm-hdmi.service" || slices.ContainsFunc(Apps, func(app App) bool { return app.Unit == unit })
}

// Select enables and starts one application, stopping the other.
func (s *Service) Select(ctx context.Context, id string) error {
	if !slices.ContainsFunc(Apps, func(app App) bool { return app.ID == id }) {
		return fmt.Errorf("未知应用 %q", id)
	}
	return s.record(s.helper(ctx, "select", id), "切换到 %s", appName(id))
}

func appName(id string) string {
	for _, app := range Apps {
		if app.ID == id {
			return app.Name
		}
	}
	return id
}

// Restart restarts an application or shared platform unit.
func (s *Service) Restart(ctx context.Context, unit string) error {
	if !Restartable(unit) {
		return fmt.Errorf("不允许重启 %s", unit)
	}
	return s.record(s.helper(ctx, "restart", unit), "重启%s", unitName(unit))
}

// SetHDRCurve applies the HDR -> SDR mapping to the running capture and keeps
// it for the next HDMI service start.
func (s *Service) SetHDRCurve(ctx context.Context, curve HDRCurve) error {
	return s.record(s.hdrCurve(ctx, "hdr-curve", curve), "保存 HDR 映射 %d / %d 尼特", curve.White, curve.Peak)
}

// PreviewHDRCurve applies the mapping without saving it, for slider drags.
func (s *Service) PreviewHDRCurve(ctx context.Context, curve HDRCurve) error {
	return s.hdrCurve(ctx, "hdr-preview", curve)
}

// hdrCurve checks the vim4-hdr-curve limits before reaching the helper.
func (s *Service) hdrCurve(ctx context.Context, action string, curve HDRCurve) error {
	if curve.White < 160 || curve.White > 1000 {
		return fmt.Errorf("SDR 白需在 160–1000 尼特之间")
	}
	if curve.Peak <= curve.White || curve.Peak > 10000 {
		return fmt.Errorf("高光上限需大于 SDR 白且不超过 10000 尼特")
	}
	return s.helper(ctx, action, strconv.Itoa(curve.White), strconv.Itoa(curve.Peak))
}

func (s *Service) helper(ctx context.Context, args ...string) error {
	if !s.mu.TryLock() {
		return ErrBusy
	}
	defer s.mu.Unlock()
	timeout := 90 * time.Second
	if len(args) > 0 && (args[0] == "edid-select" || args[0] == "update" || args[0] == "kernel-select") {
		// Finish configuration recovery even if the browser disconnects.
		ctx = context.WithoutCancel(ctx)
		timeout = 8 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	_, err := s.Run(ctx, "sudo", append([]string{"-n", Helper}, args...)...)
	if err != nil {
		return fmt.Errorf("操作失败：%s", strings.TrimPrefix(err.Error(), "sudo: "))
	}
	return nil
}

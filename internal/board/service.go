package board

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Helper is the root helper invoked through a sudoers rule.
const Helper = "/usr/libexec/vim4-manager-helper"

// ErrBusy means another switch or restart is still running.
var ErrBusy = errors.New("另一项操作正在进行")

// Service answers dashboard queries and serializes privileged operations.
type Service struct {
	Run     Runner
	Root    string
	History *History
	mu      sync.Mutex
}

// Status is the complete dashboard state.
type Status struct {
	Active   string     `json:"active"`
	Apps     []AppState `json:"apps"`
	Platform []Platform `json:"platform"`
	Hardware Hardware   `json:"hardware"`
	History  []Sample   `json:"history"`
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
	status := Status{Hardware: ReadHardware(s.Root), History: []Sample{}}
	if s.History != nil {
		status.History = s.History.Samples()
	}
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
	return s.helper(ctx, "select", id)
}

// Restart restarts an application or shared platform unit.
func (s *Service) Restart(ctx context.Context, unit string) error {
	if !Restartable(unit) {
		return fmt.Errorf("不允许重启 %s", unit)
	}
	return s.helper(ctx, "restart", unit)
}

// SetHDRCurve applies the HDR -> SDR mapping to the running capture and keeps
// it for the next HDMI service start.
func (s *Service) SetHDRCurve(ctx context.Context, curve HDRCurve) error {
	return s.hdrCurve(ctx, "hdr-curve", curve)
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
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	_, err := s.Run(ctx, "sudo", append([]string{"-n", Helper}, args...)...)
	if err != nil {
		return fmt.Errorf("操作失败：%s", strings.TrimPrefix(err.Error(), "sudo: "))
	}
	return nil
}

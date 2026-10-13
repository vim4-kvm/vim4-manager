package board

import (
	"context"
	"errors"
	"fmt"
	"slices"
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
	Run  Runner
	Root string
	mu   sync.Mutex
}

// Status is the complete dashboard state.
type Status struct {
	Active   string     `json:"active"`
	Apps     []AppState `json:"apps"`
	Platform []Platform `json:"platform"`
	Hardware Hardware   `json:"hardware"`
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
	status := Status{Hardware: ReadHardware(s.Root)}
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

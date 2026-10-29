// Package board reads the VIM4 KVM service and hardware state.
package board

import (
	"bufio"
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/i18n"
)

// App is a web KVM application. Only one may own HDMI capture, the hardware
// encoder and the HID endpoints at a time; systemd Conflicts= enforces it.
type App struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Unit        string `json:"unit"`
	Description string `json:"description"`
	Port        int    `json:"port"`
}

// Apps keeps the IDs in sync with deploy/vim4-manager-helper.
var Apps = []App{
	{ID: "pikvm", Name: "PiKVM", Unit: "vim4-pikvm.service", Port: 8080,
		Description: i18n.Message{Key: "apps.pikvm"}.Render(i18n.English)},
	{ID: "onekvm", Name: "One-KVM", Unit: "one-kvm.service", Port: 8080,
		Description: i18n.Message{Key: "apps.onekvm"}.Render(i18n.English)},
	{ID: "nanokvm", Name: "NanoKVM", Unit: "nanokvm.service", Port: 8080,
		Description: i18n.Message{Key: "apps.nanokvm"}.Render(i18n.English)},
	{ID: "jetkvm", Name: "JetKVM", Unit: "vim4-kvm.service", Port: 8080,
		Description: i18n.Message{Key: "apps.jetkvm"}.Render(i18n.English)},
}

// PlatformUnits are owned by the board package and shared by both applications.
var PlatformUnits = []struct{ Unit, Name string }{
	{"vim4-kvm-hdmi.service", i18n.Message{Key: "services.hdmi"}.Render(i18n.English)},
	{"vim4-kvm-gadget.service", i18n.Message{Key: "services.gadget"}.Render(i18n.English)},
	{"vim4-kvm-pd.service", i18n.Message{Key: "services.pd"}.Render(i18n.English)},
	{"vim4-kvm-cpufreq.service", i18n.Message{Key: "services.cpufreq"}.Render(i18n.English)},
}

// LocalizeLabels changes only manager-owned copy, never device or user names.
// Copy slices before translating so callers cannot change the service baseline.
func (status *Status) LocalizeLabels(locale i18n.Locale) {
	if status.Passthrough != nil {
		copy := *status.Passthrough
		copy.Reason = i18n.HelperText(locale, copy.Reason)
		status.Passthrough = &copy
	}
	status.Apps = append([]AppState(nil), status.Apps...)
	for index := range status.Apps {
		app := &status.Apps[index]
		switch app.ID {
		case "pikvm", "onekvm", "nanokvm", "jetkvm":
			app.Description = i18n.Message{Key: "apps." + app.ID}.Render(locale)
		}
	}
	status.Platform = append([]Platform(nil), status.Platform...)
	for index := range status.Platform {
		platform := &status.Platform[index]
		key := map[string]string{
			"vim4-kvm-hdmi.service":    "services.hdmi",
			"vim4-kvm-gadget.service":  "services.gadget",
			"vim4-kvm-pd.service":      "services.pd",
			"vim4-kvm-cpufreq.service": "services.cpufreq",
		}[platform.Unit.Name]
		if key != "" {
			platform.Name = i18n.Message{Key: key}.Render(locale)
		}
	}
}

// Unit is the subset of systemd unit properties the dashboard shows.
type Unit struct {
	Name      string     `json:"name"`
	Loaded    bool       `json:"loaded"`
	Active    string     `json:"active"`
	Sub       string     `json:"sub"`
	Enabled   string     `json:"enabled"`
	ActiveFor *time.Time `json:"since,omitempty"`
}

// Runner executes a command and returns its standard output.
type Runner func(ctx context.Context, name string, args ...string) (string, error)

// Exec runs commands with the C locale so systemctl output stays parseable.
func Exec(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = []string{"LC_ALL=C", "PATH=/usr/sbin:/usr/bin:/sbin:/bin"}
	output, err := cmd.Output()
	if exit, ok := err.(*exec.ExitError); ok {
		return string(output), i18n.HelperError(fmt.Errorf("%s: %s", name, strings.TrimSpace(string(exit.Stderr))))
	}
	return string(output), err
}

// QueryUnits reads all units in one systemctl call. Missing units report
// LoadState=not-found rather than failing the whole query.
func QueryUnits(ctx context.Context, run Runner, names []string) (map[string]Unit, error) {
	args := append([]string{"show", "--timestamp=unix",
		"--property=Id,LoadState,ActiveState,SubState,UnitFileState,ActiveEnterTimestamp"}, names...)
	output, err := run(ctx, "systemctl", args...)
	if err != nil {
		return nil, err
	}
	units := parseShow(output)
	// systemctl show reports properties in the order of its arguments; Id is
	// unreliable for missing units, so map blocks back by position.
	if len(units) != len(names) {
		return nil, fmt.Errorf("systemctl returned %d units for %d names", len(units), len(names))
	}
	result := make(map[string]Unit, len(names))
	for i, name := range names {
		units[i].Name = name
		result[name] = units[i]
	}
	return result, nil
}

// SelectedApp returns the uniquely enabled KVM application without reading
// hardware state. Ambiguous selections fail closed for gateway exemptions.
func (s *Service) SelectedApp(ctx context.Context) (string, error) {
	names := make([]string, 0, len(Apps))
	for _, app := range Apps {
		names = append(names, app.Unit)
	}
	units, err := QueryUnits(ctx, s.Run, names)
	if err != nil {
		return "", err
	}
	selected := ""
	for _, app := range Apps {
		if units[app.Unit].Enabled == "enabled" {
			if selected != "" {
				return "", fmt.Errorf("multiple KVM applications enabled")
			}
			selected = app.ID
		}
	}
	return selected, nil
}

func parseShow(output string) []Unit {
	var units []Unit
	var current *Unit
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			current = nil
			continue
		}
		if current == nil {
			units = append(units, Unit{})
			current = &units[len(units)-1]
		}
		key, value, _ := strings.Cut(line, "=")
		switch key {
		case "Id":
			current.Name = value
		case "LoadState":
			current.Loaded = value == "loaded"
		case "ActiveState":
			current.Active = value
		case "SubState":
			current.Sub = value
		case "UnitFileState":
			current.Enabled = value
		case "ActiveEnterTimestamp":
			if seconds, err := strconv.ParseInt(strings.TrimPrefix(value, "@"), 10, 64); err == nil && seconds > 0 {
				since := time.Unix(seconds, 0).UTC()
				current.ActiveFor = &since
			}
		}
	}
	return units
}

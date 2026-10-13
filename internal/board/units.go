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
	{ID: "nanokvm", Name: "NanoKVM-Pro", Unit: "nanokvm.service", Port: 8080,
		Description: "完整界面：H.264/H.265、声音、虚拟介质、网络、账户与更新"},
	{ID: "jetkvm", Name: "JetKVM", Unit: "vim4-kvm.service", Port: 8080,
		Description: "精简界面：H.264 视频、键盘与鼠标"},
}

// PlatformUnits are owned by the board package and shared by both applications.
var PlatformUnits = []struct{ Unit, Name string }{
	{"vim4-kvm-hdmi.service", "HDMI 采集"},
	{"vim4-kvm-gadget.service", "USB 键鼠"},
	{"vim4-kvm-pd.service", "USB-C 供电协商"},
	{"vim4-kvm-cpufreq.service", "CPU 性能模式"},
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
		return string(output), fmt.Errorf("%s: %s", name, strings.TrimSpace(string(exit.Stderr)))
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

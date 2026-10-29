package board

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/vim4-kvm/vim4-manager/internal/i18n"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const tailscaleControl = "https://controlplane.tailscale.com"

var tailscaleLocalHTTP = &http.Client{Transport: &http.Transport{
	DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", "/var/run/tailscale/tailscaled.sock")
	},
}, Timeout: 8 * time.Second}

// Read-only LocalAPI calls need no operator privileges. Do not expose the raw
// response: peer endpoints and other daemon details are outside the UI contract.
func (s *Service) tailscaleJSON(ctx context.Context, path string, target any) error {
	client := s.TailscaleHTTP
	if client == nil {
		client = tailscaleLocalHTTP
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://local-tailscaled.sock/localapi/v0/"+path, nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return i18n.New("tailscale.localAPIStatus", map[string]any{"status": response.StatusCode})
	}
	return json.NewDecoder(io.LimitReader(response.Body, 8<<20)).Decode(target)
}

type tailscalePeer struct {
	ID, HostName, DNSName, OS, LastSeen, Relay string
	TailscaleIPs                               []string
	Online, ExitNode, Active                   bool
}

func (s *Service) readTailscale(ctx context.Context) (TailscaleState, error) {
	state := TailscaleState{ControlURL: tailscaleControl, IPs: []string{}, Devices: []TailscaleDevice{}}
	var status struct {
		BackendState, AuthURL, Version string
		TailscaleIPs                   []string
		Self                           *tailscalePeer
		CurrentTailnet                 *struct{ Name string }
		Peer                           map[string]tailscalePeer
	}
	if err := s.tailscaleJSON(ctx, "status", &status); err != nil {
		_, cliErr := os.Stat(filepath.Join(s.Root, "usr/bin/tailscale"))
		_, daemonErr := os.Stat(filepath.Join(s.Root, "usr/sbin/tailscaled"))
		state.Installed = cliErr == nil && daemonErr == nil
		var connectionError *net.OpError
		if ctx.Err() == nil && errors.As(err, &connectionError) {
			return state, nil
		}
		return state, i18n.Wrap(err, "tailscale.readFailed", map[string]any{"p0": err})
	}
	state.Installed, state.Running = true, true
	state.BackendState, state.Version = status.BackendState, status.Version
	if validTailscaleAuthURL(status.AuthURL) {
		state.AuthURL = status.AuthURL
	}
	if status.Self != nil {
		state.HostName = status.Self.HostName
		state.DNSName = strings.TrimSuffix(status.Self.DNSName, ".")
		state.IPs = append(state.IPs, status.Self.TailscaleIPs...)
	}
	if len(status.TailscaleIPs) > 0 {
		state.IPs = status.TailscaleIPs
	}
	if status.CurrentTailnet != nil {
		state.Tailnet = status.CurrentTailnet.Name
	}
	for _, peer := range status.Peer {
		lastSeen := peer.LastSeen
		if strings.HasPrefix(lastSeen, "0001-01-01") {
			lastSeen = ""
		}
		ips := append([]string{}, peer.TailscaleIPs...)
		state.Devices = append(state.Devices, TailscaleDevice{ID: peer.ID, HostName: peer.HostName,
			DNSName: strings.TrimSuffix(peer.DNSName, "."), OS: peer.OS, IPs: ips, Online: peer.Online,
			LastSeen: lastSeen, Relay: peer.Relay, ExitNode: peer.ExitNode, Active: peer.Active})
		if peer.Online {
			state.PeersOnline++
		}
	}
	state.Peers = len(state.Devices)
	sort.Slice(state.Devices, func(i, j int) bool {
		a, b := state.Devices[i], state.Devices[j]
		if a.Online != b.Online {
			return a.Online
		}
		return strings.ToLower(a.HostName) < strings.ToLower(b.HostName)
	})
	var prefs struct{ ControlURL string }
	if err := s.tailscaleJSON(ctx, "prefs", &prefs); err != nil {
		return state, i18n.Wrap(err, "tailscale.prefsFailed", map[string]any{"p0": err})
	}
	if prefs.ControlURL != "" {
		state.ControlURL = prefs.ControlURL
	}
	return state, nil
}

func (s *Service) cachedTailscale(ctx context.Context) (TailscaleState, error) {
	// One refresh serves concurrent tabs. Failures are not cached as valid state.
	s.tailscaleReadMu.Lock()
	defer s.tailscaleReadMu.Unlock()
	if time.Since(s.tailscaleReadAt) >= 3*time.Second {
		state, err := s.readTailscale(ctx)
		if err != nil {
			return state, err
		}
		s.tailscaleState, s.tailscaleReadAt = state, time.Now()
	}
	state := s.tailscaleState
	state.IPs = append([]string{}, state.IPs...)
	state.Devices = append([]TailscaleDevice{}, state.Devices...)
	for i := range state.Devices {
		state.Devices[i].IPs = append([]string{}, state.Devices[i].IPs...)
	}
	return state, nil
}

func (s *Service) tailscalePackageJob(ctx context.Context) *TailscaleJob {
	data, err := os.ReadFile(filepath.Join(s.Root, "run/vim4-manager-tailscale-job.json"))
	if err != nil {
		return nil
	}
	var job TailscaleJob
	if json.Unmarshal(data, &job) != nil {
		return nil
	}
	if job.Running {
		state, err := s.Run(ctx, "systemctl", "show", "vim4-manager-tailscale-package.service", "--property=ActiveState", "--value")
		if err != nil || (strings.TrimSpace(state) != "active" && strings.TrimSpace(state) != "activating") {
			// The worker may have completed between reading its file and checking
			// the unit. Prefer its final result over an interruption diagnosis.
			latest, readErr := os.ReadFile(filepath.Join(s.Root, "run/vim4-manager-tailscale-job.json"))
			var completed TailscaleJob
			if readErr == nil && json.Unmarshal(latest, &completed) == nil && !completed.Running {
				return &completed
			}
			job.failure = i18n.New("tailscale.packageInterrupted", nil)
			job.Running, job.Error = false, job.failure.Error()
		}
	}
	return &job
}

// LocalizeTailscaleJob renders a response copy. Shared job state remains in
// English, so one browser cannot change another browser's language.
func LocalizeTailscaleJob(job *TailscaleJob, locale i18n.Locale) {
	if job.failure != nil {
		job.Error = i18n.RenderError(locale, job.failure)
	} else {
		job.Error = NetworkHelperText(locale, job.Error)
	}
}

func NetworkHelperText(locale i18n.Locale, text string) string {
	if message, ok := networkHelperMessage(text); ok {
		return message.Render(locale)
	}
	return i18n.HelperText(locale, text)
}

func networkHelperError(err error) error {
	if err == nil {
		return nil
	}
	var contextual *i18n.Error
	if errors.As(err, &contextual) && contextual.Message.Key == "common.operationFailed" {
		if reason, ok := contextual.Message.Args["reason"].(error); ok {
			return i18n.Wrap(err, contextual.Message.Key, map[string]any{"reason": networkHelperError(reason)})
		}
	}
	if message, ok := networkHelperMessage(err.Error()); ok {
		return i18n.Wrap(err, message.Key, message.Args)
	}
	return i18n.HelperError(err)
}

var networkCommandFailure = regexp.MustCompile(`^([a-zA-Z0-9/-]+ [a-zA-Z0-9-]+) failed: (.*)$`)
var tailscaleAPIStatus = regexp.MustCompile(`^Tailscale local API failed \(([0-9]+)\)$`)
var updateNotInstalled = regexp.MustCompile(`^([a-zA-Z0-9-]+) is not installed; deploy it with the component packages$`)

func networkHelperMessage(text string) (i18n.Message, bool) {
	text = strings.TrimPrefix(text, "sudo: ")
	for _, pattern := range i18n.KernelMediaLegacyPatterns {
		if matches := regexp.MustCompile(pattern).FindStringSubmatch(text); matches != nil {
			return i18n.Message{Key: "kernel.mediaMounted", Args: map[string]any{"name": matches[1]}}, true
		}
	}
	if key, ok := i18n.NetworkHelperLegacy[text]; ok {
		return i18n.Message{Key: key}, true
	}
	for _, key := range i18n.NetworkHelperLegacy {
		message := i18n.Message{Key: key}
		if text == message.Render(i18n.English) {
			return message, true
		}
	}
	for _, suffix := range i18n.NetworkHelperSuffixes {
		if reason, ok := strings.CutSuffix(text, suffix); ok {
			var detail any = reason
			if message, known := networkHelperMessage(reason); known {
				detail = message
			}
			return i18n.Message{Key: "wifi.hotspotRestoredReason", Args: map[string]any{"reason": detail}}, true
		}
	}
	if matches := networkCommandFailure.FindStringSubmatch(text); matches != nil {
		return i18n.Message{Key: "tailscale.commandFailed", Args: map[string]any{"command": matches[1], "detail": matches[2]}}, true
	}
	if matches := tailscaleAPIStatus.FindStringSubmatch(text); matches != nil {
		return i18n.Message{Key: "tailscale.localAPIStatus", Args: map[string]any{"status": matches[1]}}, true
	}
	if matches := updateNotInstalled.FindStringSubmatch(text); matches != nil {
		return i18n.Message{Key: "updates.componentMissing", Args: map[string]any{"package": matches[1]}}, true
	}
	return i18n.Message{}, false
}

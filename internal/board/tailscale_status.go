package board

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
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
		return fmt.Errorf("Tailscale LocalAPI: HTTP %d", response.StatusCode)
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
		return state, fmt.Errorf("无法读取 Tailscale：%w", err)
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
		return state, fmt.Errorf("无法读取 Tailscale 配置：%w", err)
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
			job.Running, job.Error = false, "Tailscale 包操作已中断，请重试"
		}
	}
	return &job
}

package board

import (
	"context"
	"encoding/json"
	"fmt"
	"net/netip"
	"regexp"
	"strings"
	"time"
)

// TailscaleState describes the machine-wide daemon, independently of the KVM app.
type TailscaleState struct {
	Installed    bool              `json:"installed"`
	Running      bool              `json:"running"`
	BackendState string            `json:"backendState"`
	AuthURL      string            `json:"authURL"`
	HostName     string            `json:"hostName"`
	DNSName      string            `json:"dnsName"`
	IPs          []string          `json:"ips"`
	Tailnet      string            `json:"tailnet"`
	ControlURL   string            `json:"controlURL"`
	Version      string            `json:"version"`
	Peers        int               `json:"peers"`
	PeersOnline  int               `json:"peersOnline"`
	Devices      []TailscaleDevice `json:"devices"`
	Job          *TailscaleJob     `json:"job,omitempty"`
}

// TailscaleDevice is a peer known to the daemon, excluding this machine.
type TailscaleDevice struct {
	ID       string   `json:"id"`
	HostName string   `json:"hostName"`
	DNSName  string   `json:"dnsName"`
	OS       string   `json:"os"`
	IPs      []string `json:"ips"`
	Online   bool     `json:"online"`
	LastSeen string   `json:"lastSeen"`
	CurAddr  string   `json:"curAddr"`
	Relay    string   `json:"relay"`
	ExitNode bool     `json:"exitNode"`
	Active   bool     `json:"active"`
}

// TailscalePingResult describes replies and losses; Path and Via reflect the last reply.
type TailscalePingResult struct {
	Reachable bool      `json:"reachable"`
	Path      string    `json:"path"`
	Via       string    `json:"via"`
	LatencyMs []float64 `json:"latencyMs"`
	Lost      int       `json:"lost"`
	Sent      int       `json:"sent"`
}

var tailscaleNetworks = []netip.Prefix{
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("fd7a:115c:a1e0::/48"),
}

// TailscalePing probes a current peer without changing job state or recording events.
// At most two probes may run per service; excess requests fail immediately.
func (s *Service) TailscalePing(ctx context.Context, ip string) (TailscalePingResult, error) {
	result := TailscalePingResult{LatencyMs: []float64{}}
	address, err := netip.ParseAddr(ip)
	if err != nil || address.Zone() != "" ||
		!(tailscaleNetworks[0].Contains(address) || tailscaleNetworks[1].Contains(address)) {
		return result, fmt.Errorf("需要有效的 Tailscale IP 地址")
	}
	s.tailscalePingOnce.Do(func() { s.tailscalePings = make(chan struct{}, 2) })
	select {
	case s.tailscalePings <- struct{}{}:
		defer func() { <-s.tailscalePings }()
	default:
		return result, ErrBusy
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	output, err := s.Run(ctx, "sudo", "-n", Helper, "tailscale-ping", address.String())
	if err != nil {
		return result, fmt.Errorf("Tailscale 连接测试失败：%s", strings.TrimPrefix(err.Error(), "sudo: "))
	}
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		return result, fmt.Errorf("Tailscale 连接测试结果无效：%w", err)
	}
	return result, nil
}

// TailscaleJob keeps the most recent action's outcome until the next action or restart.
type TailscaleJob struct {
	Action  string `json:"action"`
	Running bool   `json:"running"`
	Error   string `json:"error"`
}

func (s *Service) Tailscale(ctx context.Context) (TailscaleState, error) {
	state := TailscaleState{IPs: []string{}, Devices: []TailscaleDevice{}}
	output, err := s.Run(ctx, "sudo", "-n", Helper, "tailscale-status")
	if err != nil {
		return state, fmt.Errorf("无法读取 Tailscale：%w", err)
	}
	if err := json.Unmarshal([]byte(output), &state); err != nil {
		return state, fmt.Errorf("Tailscale 状态无效：%w", err)
	}
	if state.Devices == nil {
		state.Devices = []TailscaleDevice{}
	}
	s.tailscaleMu.Lock()
	defer s.tailscaleMu.Unlock()
	if s.tailscaleJob != nil {
		job := *s.tailscaleJob
		state.Job = &job
	}
	return state, nil
}

// Keep the control-server allowlist identical to the root helper's validation.
var tailscaleControlURL = regexp.MustCompile(`^https?://[A-Za-z0-9.-]+(?::[0-9]{1,5})?$`)

// TailscaleAction starts package work in the background, or waits at most one
// minute for other actions. Login returns the daemon's browser authorization URL.
func (s *Service) TailscaleAction(ctx context.Context, action, controlURL string) (string, error) {
	var label string
	switch action {
	case "install":
		label = "安装 Tailscale"
	case "uninstall":
		label = "卸载 Tailscale"
	case "up":
		label = "连接 Tailscale"
	case "down":
		label = "断开 Tailscale"
	case "login":
		label = "发起 Tailscale 登录"
		if !tailscaleControlURL.MatchString(controlURL) {
			return "", fmt.Errorf("控制服务器地址需为 http(s)://host[:port]")
		}
	case "logout":
		label = "退出 Tailscale 登录"
	default:
		return "", fmt.Errorf("未知 Tailscale 操作 %q", action)
	}
	if action != "login" && controlURL != "" {
		return "", fmt.Errorf("控制服务器只能在登录时指定")
	}

	s.tailscaleMu.Lock()
	if s.tailscaleJob != nil && s.tailscaleJob.Running {
		s.tailscaleMu.Unlock()
		return "", ErrBusy
	}
	s.tailscaleJob = &TailscaleJob{Action: action, Running: true}
	s.tailscaleMu.Unlock()

	if action == "install" || action == "uninstall" {
		// Package installation must finish even when the initiating request ends.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Minute)
		go func() {
			defer cancel()
			_, _ = s.runTailscaleAction(ctx, action, controlURL, label)
		}()
		return "", nil
	}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	return s.runTailscaleAction(ctx, action, controlURL, label)
}

func (s *Service) runTailscaleAction(ctx context.Context, action, controlURL, label string) (string, error) {
	args := []string{"-n", Helper, "tailscale-" + action}
	if action == "login" {
		args = append(args, controlURL)
	}
	// This subsystem owns its own job lock; s.helper would serialize KVM switches.
	output, err := s.Run(ctx, "sudo", args...)
	if err != nil {
		err = fmt.Errorf("Tailscale 操作失败：%s", strings.TrimPrefix(err.Error(), "sudo: "))
	}
	var result struct {
		AuthURL string `json:"authURL"`
	}
	if err == nil && action == "login" {
		if decodeErr := json.Unmarshal([]byte(output), &result); decodeErr != nil {
			err = fmt.Errorf("Tailscale 登录结果无效：%w", decodeErr)
		}
	}
	err = s.record(err, "%s", label)
	s.tailscaleMu.Lock()
	s.tailscaleJob.Running = false
	if err != nil {
		s.tailscaleJob.Error = err.Error()
	}
	s.tailscaleMu.Unlock()
	return result.AuthURL, err
}

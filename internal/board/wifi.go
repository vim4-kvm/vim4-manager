package board

import (
	"context"
	"fmt"
	"strings"
)

// WifiState reports radio state independently of whether a network is connected.
type WifiState struct {
	Supported       bool `json:"supported"`
	Enabled         bool `json:"enabled"`
	HardwareEnabled bool `json:"hardwareEnabled"`
}

func (s *Service) Wifi(ctx context.Context) (WifiState, error) {
	devices, err := s.Run(ctx, "nmcli", "-t", "-f", "TYPE", "device")
	if err != nil {
		return WifiState{}, fmt.Errorf("无法读取无线设备：%w", err)
	}
	state := WifiState{}
	for _, kind := range strings.Fields(devices) {
		if kind == "wifi" {
			state.Supported = true
		}
	}
	if !state.Supported {
		return state, nil
	}
	radio, err := s.Run(ctx, "nmcli", "-t", "-f", "WIFI-HW,WIFI", "general")
	if err != nil {
		return state, fmt.Errorf("无法读取 Wi-Fi 状态：%w", err)
	}
	parts := strings.Split(strings.TrimSpace(radio), ":")
	if len(parts) != 2 || (parts[0] != "enabled" && parts[0] != "disabled") || (parts[1] != "enabled" && parts[1] != "disabled") {
		return state, fmt.Errorf("无法识别 Wi-Fi 状态")
	}
	state.HardwareEnabled = parts[0] == "enabled"
	state.Enabled = parts[1] == "enabled"
	return state, nil
}

func (s *Service) SetWifi(ctx context.Context, enabled bool) error {
	value := "off"
	if enabled {
		value = "on"
	}
	label := map[bool]string{true: "开启 Wi-Fi", false: "关闭 Wi-Fi"}[enabled]
	return s.record(s.helper(ctx, "wifi", value), "%s", label)
}

package board

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
)

type Kernel struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Release   string `json:"release"`
	Selected  bool   `json:"selected"`
	Available bool   `json:"available"`
	Error     string `json:"error"`
}

type KernelState struct {
	Running string   `json:"running"`
	Kernels []Kernel `json:"kernels"`
}

func (s *Service) Kernels(ctx context.Context) (KernelState, error) {
	var state KernelState
	output, err := s.Run(ctx, "sudo", "-n", Helper, "kernel-status")
	if err != nil {
		return state, fmt.Errorf("无法读取内核：%w", err)
	}
	if err := json.Unmarshal([]byte(output), &state); err != nil {
		return state, err
	}
	return state, nil
}

func (s *Service) SelectKernel(ctx context.Context, id string, reboot bool) error {
	if id != "vendor" && id != "mainline" {
		return fmt.Errorf("未知内核")
	}
	return s.record(s.helper(ctx, "kernel-select", id, strconv.FormatBool(reboot)), "选择内核 %s，重启：%t", id, reboot)
}

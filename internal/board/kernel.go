package board

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/vim4-kvm/vim4-manager/internal/i18n"
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
		return state, i18n.Wrap(err, "kernel.readFailed", map[string]any{"reason": err})
	}
	if err := json.Unmarshal([]byte(output), &state); err != nil {
		return state, i18n.Wrap(err, "kernel.invalidResponse", nil)
	}
	return state, nil
}

func (s *Service) SelectKernel(ctx context.Context, id string, reboot bool) error {
	if id != "vendor" && id != "mainline" {
		return i18n.New("kernel.unknown", nil)
	}
	return s.recordMessage(networkHelperError(s.helper(ctx, "kernel-select", id, strconv.FormatBool(reboot))), i18n.Message{Key: "events.kernelSelected", Args: map[string]any{"id": id, "reboot": reboot}})
}

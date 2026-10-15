package board

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
)

type EDIDPreset struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

type EDIDState struct {
	Presets      []EDIDPreset `json:"presets"`
	Selected     string       `json:"selected"`
	SavedName    string       `json:"savedName"`
	Active       string       `json:"active"`
	ActiveKnown  bool         `json:"activeKnown"`
	JetKVMSynced bool         `json:"jetkvmSynced"`
}

func (s *Service) EDID(ctx context.Context) (EDIDState, error) {
	var state EDIDState
	output, err := s.Run(ctx, "sudo", "-n", Helper, "edid-status")
	if err != nil {
		return state, fmt.Errorf("无法读取 EDID：%w", err)
	}
	if err := json.Unmarshal([]byte(output), &state); err != nil {
		return state, fmt.Errorf("EDID 状态无效：%w", err)
	}
	return state, nil
}

var edidID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

func (s *Service) SetEDID(ctx context.Context, id string) error {
	if !edidID.MatchString(id) {
		return fmt.Errorf("EDID 预设标识无效")
	}
	return s.helper(ctx, "edid-select", id)
}

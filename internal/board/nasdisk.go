package board

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"time"
)

type NASDiskRequest struct {
	ID      string `json:"id,omitempty"`
	Storage string `json:"storage,omitempty"`
	Path    string `json:"path,omitempty"`
	Mode    string `json:"mode,omitempty"`
	Label   string `json:"label,omitempty"`
	Force   bool   `json:"force,omitempty"`
	Confirm string `json:"confirm,omitempty"`
}

func (s *Service) NASDiskCommand(ctx context.Context, action string, request *NASDiskRequest) (json.RawMessage, error) {
	switch action {
	case "status", "start", "cancel", "commit", "reattach", "discard":
	default:
		return nil, fmt.Errorf("不支持的 NAS U 盘操作")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	args := []string{"-n", Helper, "nasdisk-" + action}
	if action == "commit" || action == "reattach" || action == "discard" {
		if request == nil || request.ID == "" {
			return nil, fmt.Errorf("缺少会话 ID")
		}
		args = append(args, request.ID)
		if action == "commit" && request.Force {
			args = append(args, "force")
		}
	}
	var input, output bytes.Buffer
	if request != nil {
		if err := json.NewEncoder(&input).Encode(request); err != nil {
			return nil, err
		}
	}
	run := s.Stream
	if run == nil {
		run = ExecStream
	}
	if err := run(ctx, &input, &output, "sudo", args...); err != nil {
		if err.Error() == "另一个 NAS U 盘操作正在进行，请稍后重试" {
			return nil, ErrBusy
		}
		return nil, err
	}
	if !json.Valid(output.Bytes()) {
		return nil, fmt.Errorf("NAS U 盘响应无效")
	}
	return json.RawMessage(output.Bytes()), nil
}

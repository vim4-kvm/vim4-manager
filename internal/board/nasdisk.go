package board

import (
	"bytes"
	"context"
	"encoding/json"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/i18n"
)

type NASDiskRequest struct {
	ID               string `json:"id,omitempty"`
	Storage          string `json:"storage,omitempty"`
	Path             string `json:"path,omitempty"`
	Mode             string `json:"mode,omitempty"`
	Label            string `json:"label,omitempty"`
	Force            bool   `json:"force,omitempty"`
	Confirm          string `json:"confirm,omitempty"`
	UTCOffsetMinutes *int   `json:"utcOffsetMinutes,omitempty"`
}

func (s *Service) NASDiskCommand(ctx context.Context, action string, request *NASDiskRequest) (json.RawMessage, error) {
	if action == "start" && request != nil && request.UTCOffsetMinutes != nil && (*request.UTCOffsetMinutes < -720 || *request.UTCOffsetMinutes > 840) {
		return nil, i18n.New("nasDisk.timezone", nil)
	}
	switch action {
	case "status", "start", "cancel", "commit", "reattach", "discard", "trash-empty":
	default:
		return nil, i18n.New("nasDisk.unsupported", nil)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	args := []string{"-n", Helper, "nasdisk-" + action}
	if action == "commit" || action == "reattach" || action == "discard" {
		if request == nil || request.ID == "" {
			return nil, i18n.New("nasDisk.missingSession", nil)
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
		if err.Error() == (i18n.Message{Key: "nasDisk.busy"}).Render(i18n.English) || err.Error() == (i18n.Message{Key: "nasDisk.busy"}).Render(i18n.Chinese) {
			return nil, i18n.Wrap(ErrBusy, "nasDisk.busy", nil)
		}
		return nil, storageHelperError(err)
	}
	if !json.Valid(output.Bytes()) {
		return nil, i18n.New("nasDisk.invalidResponse", nil)
	}
	return json.RawMessage(output.Bytes()), nil
}

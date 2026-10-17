package board

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// StorageRequest keeps secrets in the JSON body passed to the helper's stdin.
// A nil password preserves saved credentials; a pointer to "" sets an empty one.
type StorageRequest struct {
	ID        string  `json:"id,omitempty"`
	Name      string  `json:"name"`
	Path      string  `json:"path,omitempty"`
	Type      string  `json:"type"`
	Server    string  `json:"server"`
	Share     string  `json:"share"`
	Domain    string  `json:"domain"`
	Username  string  `json:"username"`
	Password  *string `json:"password,omitempty"`
	Version   string  `json:"version,omitempty"`
	AutoMount bool    `json:"autoMount"`
	Confirm   string  `json:"confirm,omitempty"`
}

// StorageCommand bypasses service switching locks. The helper serializes NAS
// mutations separately and validates every field at the privilege boundary.
func (s *Service) StorageCommand(ctx context.Context, action string, request *StorageRequest, args ...string) (json.RawMessage, error) {
	switch action {
	case "storage-list", "storage-dirs", "storage-mkdir", "storage-test", "storage-save", "storage-mount", "storage-unmount", "storage-delete":
	default:
		return nil, fmt.Errorf("不支持的网络存储操作")
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	var input, output bytes.Buffer
	if request != nil {
		if err := json.NewEncoder(&input).Encode(request); err != nil {
			return nil, fmt.Errorf("网络存储参数无效")
		}
	}
	run := s.Stream
	if run == nil {
		run = ExecStream
	}
	command := append([]string{"-n", Helper, action}, args...)
	if err := run(ctx, &input, &output, "sudo", command...); err != nil {
		if request != nil && request.Password != nil && *request.Password != "" && strings.Contains(err.Error(), *request.Password) {
			return nil, fmt.Errorf("网络存储操作失败（敏感错误内容已隐藏）")
		}
		if err.Error() == "另一个网络存储操作正在进行，请稍后重试" {
			return nil, ErrBusy
		}
		return nil, err
	}
	if !json.Valid(output.Bytes()) {
		return nil, fmt.Errorf("网络存储响应无效")
	}
	return json.RawMessage(output.Bytes()), nil
}

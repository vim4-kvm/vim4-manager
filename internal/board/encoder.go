package board

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Encoder reports the kernel's irreversible quarantine, independent of clients.
type Encoder struct {
	Known       bool   `json:"known"`
	Isolated    bool   `json:"isolated"`
	Reason      string `json:"reason,omitempty"`
	TimeNS      string `json:"timeBoottimeNs,omitempty"`
	NeedsReboot bool   `json:"needsReboot"`
}

func readEncoder(root string) Encoder {
	paths, _ := filepath.Glob(filepath.Join(root, "sys/bus/platform/drivers/vdec/*/isolated"))
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		state := strings.TrimSpace(string(data))
		if state != "0" && state != "1" {
			continue
		}
		encoder := Encoder{Known: true, Isolated: state == "1", NeedsReboot: state == "1"}
		if encoder.Isolated {
			reason, _ := os.ReadFile(filepath.Join(filepath.Dir(path), "isolation_reason"))
			encoder.Reason = strings.TrimSpace(string(reason))
			data, _ = os.ReadFile(filepath.Join(filepath.Dir(path), "isolation_time_ns"))
			// Keep nanoseconds exact for JavaScript consumers after a long uptime.
			if ns, err := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64); err == nil {
				encoder.TimeNS = strconv.FormatUint(ns, 10)
			}
		}
		return encoder
	}
	return Encoder{}
}

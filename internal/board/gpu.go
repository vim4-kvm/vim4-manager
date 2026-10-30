package board

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type gpuSnapshot struct {
	Device  string                       `json:"device"`
	TimeNS  int64                        `json:"timeNs"`
	Clients map[string]map[string]uint64 `json:"clients"`
}

// sampleGPU runs under the history lock so snapshot windows cannot overlap.
func (h *History) sampleGPU() *float64 {
	data, err := os.ReadFile(filepath.Join(h.Root, "sys/class/mpgpu/utilization"))
	if err == nil {
		h.gpu = nil
		// Keep the vendor's latest DVFS interval and invalid-value behavior.
		if value, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil && value >= 0 && value <= 100 {
			percent := float64(value)
			return &percent
		}
		return nil
	}
	previous := h.gpu
	h.gpu = nil
	if h.Execute == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	text, err := h.Execute(ctx, "sudo", "-n", Helper, "gpu-snapshot")
	var current *gpuSnapshot
	if err != nil || json.Unmarshal([]byte(text), &current) != nil || current == nil || current.Device == "" || current.Clients == nil {
		return nil
	}
	h.gpu = current
	return estimateGPU(previous, current)
}

// Sum clients within each engine, then use the busiest engine, capped at 100%.
// Vertex/tiler and fragment work can overlap: their maximum is a lower-bound
// approximation of GPU busy wall time; fdinfo cannot reconstruct the union.
// Driver timing errors mean this is not a strict mathematical bound. Client
// churn loses an interval rather than creating idle readings or wrap spikes.
func estimateGPU(previous, current *gpuSnapshot) *float64 {
	if previous == nil || current.Device != previous.Device || current.TimeNS <= previous.TimeNS || len(current.Clients) != len(previous.Clients) {
		return nil
	}
	engineBusy := [2]float64{}
	for id, engines := range current.Clients {
		old, ok := previous.Clients[id]
		if !ok || len(engines) != 2 || len(old) != 2 {
			return nil
		}
		for i, engine := range []string{"fragment", "vertex-tiler"} {
			now, ok := engines[engine]
			before, existed := old[engine]
			if !ok || !existed || now < before {
				return nil
			}
			engineBusy[i] += float64(now - before)
		}
	}
	percent := min(100, 100*max(engineBusy[0], engineBusy[1])/float64(current.TimeNS-previous.TimeNS))
	return &percent
}

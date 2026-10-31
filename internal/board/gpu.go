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
	Kbase   *kbaseMetrics                `json:"kbase,omitempty"`
}

// r44p0 JM counters are cumulative u32 values in units of 256 ns.
type kbaseMetrics struct {
	Busy uint32 `json:"busy"`
	Idle uint32 `json:"idle"`
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
	text, err := h.Execute(ctx, "sudo", "-n", "/opt/vim4-manager/vim4-manager", "gpu-snapshot")
	var current *gpuSnapshot
	if err != nil || json.Unmarshal([]byte(text), &current) != nil || current == nil || current.Device == "" || current.Clients == nil && current.Kbase == nil {
		return nil
	}
	h.gpu = current
	return estimateGPU(previous, current)
}

// Kbase uses busy/idle PM metrics. For Panfrost, sum clients within each engine,
// then use the busiest engine, capped at 100%.
// Vertex/tiler and fragment work can overlap: their maximum is a lower-bound
// approximation of GPU busy wall time; fdinfo cannot reconstruct the union.
// Driver timing errors mean this is not a strict mathematical bound. Client
// churn loses an interval rather than creating idle readings or wrap spikes.
func estimateGPU(previous, current *gpuSnapshot) *float64 {
	if previous == nil || current.Device != previous.Device || current.TimeNS <= previous.TimeNS {
		return nil
	}
	if current.Kbase != nil || previous.Kbase != nil {
		return estimateKbase(previous, current)
	}
	if len(current.Clients) != len(previous.Clients) {
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

func estimateKbase(previous, current *gpuSnapshot) *float64 {
	if previous.Kbase == nil || current.Kbase == nil {
		return nil
	}
	// A decreasing counter can be either reset or wrap. Re-prime rather than
	// invent work; a u32 wraps after about 1099 seconds of busy or idle time.
	before, after := previous.Kbase, current.Kbase
	if after.Busy < before.Busy || after.Idle < before.Idle {
		return nil
	}
	busy := uint64(after.Busy - before.Busy)
	idle := uint64(after.Idle - before.Idle)
	// Longer windows may hide a complete wrap. Zero total is stale/unavailable,
	// not idle: a valid idle interval advances the idle counter.
	if current.TimeNS-previous.TimeNS >= (1<<32)*256 || busy+idle == 0 {
		return nil
	}
	percent := 100 * float64(busy) / float64(busy+idle)
	return &percent
}

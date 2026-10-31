package board

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestKbaseBackendPriorityAndRecovery(t *testing.T) {
	root := t.TempDir()
	device := "sys/bus/platform/drivers/mali/fe400000.gpu"
	if err := os.MkdirAll(filepath.Join(root, device), 0755); err != nil {
		t.Fatal(err)
	}
	// A kbase device without metrics must not enable Panfrost profiling.
	profiling := "sys/bus/platform/drivers/panfrost/fe400000.gpu/profiling"
	gpuFixtureWrite(t, root, profiling, "0\n")
	if s, err := readGPUSnapshot(root); err != nil || s != nil {
		t.Fatalf("missing metrics: %v %v", s, err)
	}
	data, _ := os.ReadFile(filepath.Join(root, profiling))
	if string(data) != "0\n" {
		t.Fatal("kbase discovery enabled Panfrost profiling")
	}
	metrics := "sys/kernel/debug/mali0/dvfs_utilization"
	gpuFixtureWrite(t, root, metrics, "busy_time: 100 idle_time: 300\n")
	s, err := readGPUSnapshot(root)
	if err != nil || s == nil || s.Kbase == nil || s.Kbase.Busy != 100 || s.Kbase.Idle != 300 {
		t.Fatalf("recovered metrics: %v %v", s, err)
	}
	for _, invalid := range []string{"busy_time: 4294967296 idle_time: 0", "busy_time: -1 idle_time: 0", "busy_time: 1", "busy_time: 1 idle_time: 2 protm_time: 3"} {
		gpuFixtureWrite(t, root, metrics, invalid)
		if s, err := readGPUSnapshot(root); err == nil || s != nil {
			t.Fatalf("invalid metrics accepted: %q", invalid)
		}
	}
	// Removing kbase makes the existing Panfrost backend discoverable again.
	if err := os.Remove(filepath.Join(root, device)); err != nil {
		t.Fatal(err)
	}
	if _, err := readGPUSnapshot(root); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(filepath.Join(root, profiling))
	if string(data) != "1\n" {
		t.Fatal("Panfrost did not recover")
	}
}

func TestKbaseSamplingWindows(t *testing.T) {
	root := t.TempDir()
	var snapshot *gpuSnapshot
	h := &History{Root: root, Execute: func(context.Context, string, ...string) (string, error) {
		data, err := json.Marshal(snapshot)
		return string(data), err
	}}
	percent := func(n float64) *float64 { return &n }
	cases := []struct {
		time       int64
		busy, idle uint32
		missing    bool
		want       *float64
	}{
		{1, 0, 0, false, nil},
		{6, 0, 100, false, percent(0)},
		{11, 100, 100, false, percent(100)},
		{21, 150, 250, false, percent(25)}, // delayed window: busy / (busy + idle)
		{26, 150, 250, false, nil},         // stopped counters are not idle
		{31, 200, 300, false, percent(50)},
		{36, 0, 0, true, nil},
		{41, 300, 400, false, nil}, // recovery primes
		{46, 300, 500, false, percent(0)},
		{51, ^uint32(0), 500, false, percent(100)},
		{56, 10, 500, false, nil}, // busy wraps
		{61, 20, 510, false, percent(50)},
		{66, 20, 0, false, nil}, // idle resets
		{71, 20, 100, false, percent(0)},
		{71, 30, 110, false, nil},   // non-positive window
		{2000, 40, 120, false, nil}, // a complete wrap could be hidden
		{2005, 50, 130, false, percent(50)},
	}
	for i, tc := range cases {
		snapshot = &gpuSnapshot{Device: "mali", TimeNS: tc.time * 1e9, Kbase: &kbaseMetrics{Busy: tc.busy, Idle: tc.idle}}
		if tc.missing {
			snapshot = nil
		}
		got := h.sampleGPU()
		if (got == nil) != (tc.want == nil) || got != nil && *got != *tc.want {
			t.Fatalf("step %d: got %v want %v", i, got, tc.want)
		}
	}
	// mpgpu appearing immediately supersedes the counter backend; removing it
	// must not reuse an old kbase window across the vendor interval.
	vendor := "sys/class/mpgpu/utilization"
	gpuFixtureWrite(t, root, vendor, "43\n")
	if got := h.sampleGPU(); got == nil || *got != 43 {
		t.Fatal("vendor priority", got)
	}
	if err := os.Remove(filepath.Join(root, vendor)); err != nil {
		t.Fatal(err)
	}
	if h.sampleGPU() != nil {
		t.Fatal("backend switch must prime")
	}
}

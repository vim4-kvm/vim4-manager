package board

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestHistoryPanfrostWindowsAndRecovery(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "proc"), 0755); err != nil {
		t.Fatal(err)
	}
	var snapshot *gpuSnapshot
	h := &History{Root: root, Capacity: 30, Execute: func(_ context.Context, _ string, args ...string) (string, error) {
		if args[len(args)-1] != "gpu-snapshot" {
			return "null", nil
		}
		data, err := json.Marshal(snapshot)
		return string(data), err
	}}
	client := func(ns uint64) map[string]map[string]uint64 {
		return map[string]map[string]uint64{"42": {"fragment": ns, "vertex-tiler": 0}}
	}
	percent := func(p float64) *float64 { return &p }
	cases := []struct {
		seconds int64
		clients map[string]map[string]uint64
		want    *float64
	}{
		{1, client(0), nil}, // prime
		{6, client(0), percent(0)},
		{11, client(5e9), percent(100)},
		{21, client(10e9), percent(50)},  // delayed sample uses ten seconds
		{26, client(20e9), percent(100)}, // overlap / completed jobs cap at 100
		{31, client(1), nil},             // reset or wrap
		{36, client(1), percent(0)},
		{41, map[string]map[string]uint64{}, nil}, // process exited
		{46, map[string]map[string]uint64{}, percent(0)},
		{51, nil, nil},          // unavailable, never retain idle or load
		{56, client(30e9), nil}, // recovery primes
		{61, client(31e9), percent(20)},
	}
	for i, tc := range cases {
		snapshot = &gpuSnapshot{Device: "panfrost", TimeNS: tc.seconds * 1e9, Clients: tc.clients}
		if err := os.WriteFile(filepath.Join(root, "proc/stat"), []byte(fmt.Sprintf("cpu 0 0 0 %d\n", (i+1)*100)), 0644); err != nil {
			t.Fatal(err)
		}
		h.Sample(time.Unix(tc.seconds, 0))
		if i == 0 {
			continue
		}
		samples := h.Samples()
		got := samples[len(samples)-1].GPU
		if (got == nil) != (tc.want == nil) || got != nil && *got != *tc.want {
			t.Fatalf("step %d: got %v, want %v", i, got, tc.want)
		}
	}
}

func TestPanfrostAggregatesClientsAndEngines(t *testing.T) {
	before := &gpuSnapshot{Device: "gpu", TimeNS: 1e9, Clients: map[string]map[string]uint64{
		"1": {"fragment": 0, "vertex-tiler": 0}, "2": {"fragment": 0, "vertex-tiler": 0},
	}}
	after := &gpuSnapshot{Device: "gpu", TimeNS: 6e9, Clients: map[string]map[string]uint64{
		"1": {"fragment": 1e9, "vertex-tiler": 1e9}, "2": {"fragment": 1e9, "vertex-tiler": 0},
	}}
	if got := estimateGPU(before, after); got == nil || *got != 60 {
		t.Fatal("all clients and both engines must contribute", got)
	}
	after.TimeNS = before.TimeNS
	if estimateGPU(before, after) != nil {
		t.Fatal("zero sample window")
	}
	after.TimeNS = 6e9
	after.Clients["3"] = after.Clients["2"]
	delete(after.Clients, "2")
	if estimateGPU(before, after) != nil {
		t.Fatal("same-sized client replacement must invalidate the window")
	}
}

func TestVendorGPUDoesNotInvokePanfrost(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "sys/class/mpgpu")
	if err := os.MkdirAll(path, 0755); err != nil {
		t.Fatal(err)
	}
	h := &History{Root: root, Execute: func(context.Context, string, ...string) (string, error) {
		t.Fatal("vendor sampling invoked helper")
		return "", nil
	}}
	for _, value := range []string{"43", "0", "100", "invalid", "101"} {
		if err := os.WriteFile(filepath.Join(path, "utilization"), []byte(value), 0644); err != nil {
			t.Fatal(err)
		}
		got := h.sampleGPU()
		if value == "invalid" || value == "101" {
			if got != nil {
				t.Fatal("invalid vendor reading")
			}
		} else if got == nil {
			t.Fatal("missing vendor reading")
		}
	}
}

func TestPanfrostHelperFailureAndCounterWrap(t *testing.T) {
	var output = `{"device":"gpu","timeNs":100,"clients":{}}`
	h := &History{Root: t.TempDir(), Execute: func(context.Context, string, ...string) (string, error) {
		return output, nil
	}}
	h.sampleGPU()
	output = `broken helper output`
	if h.sampleGPU() != nil {
		t.Fatal("invalid helper output")
	}
	output = `{"device":"gpu","timeNs":200,"clients":{}}`
	if h.sampleGPU() != nil {
		t.Fatal("recovery must prime")
	}
	output = `{"device":"gpu","timeNs":300,"clients":{}}`
	if got := h.sampleGPU(); got == nil || *got != 0 {
		t.Fatal("idle recovery", got)
	}
	before := &gpuSnapshot{Device: "gpu", TimeNS: 100, Clients: map[string]map[string]uint64{
		"42": {"fragment": ^uint64(0), "vertex-tiler": 0},
	}}
	after := &gpuSnapshot{Device: "gpu", TimeNS: 200, Clients: map[string]map[string]uint64{
		"42": {"fragment": 1, "vertex-tiler": 0},
	}}
	if estimateGPU(before, after) != nil {
		t.Fatal("wrapped counter must not spike")
	}
}

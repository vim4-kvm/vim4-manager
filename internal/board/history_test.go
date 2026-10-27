package board

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestHistoryGPUUnavailableAndRecovery(t *testing.T) {
	root := t.TempDir()
	write := func(path, value string) {
		t.Helper()
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(value), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h := &History{Root: root, Capacity: 12}
	write("proc/stat", "cpu 0 0 0 100\n")
	h.Sample(time.Unix(1000, 0))
	// Missing/invalid data must not become idle or retain the previous load.
	for i, value := range []string{"missing", "43\n", "0\n", "100", "-1", "101", "invalid", "25.5", "", "72\n"} {
		if value != "missing" {
			write("sys/class/mpgpu/utilization", value)
		}
		write("proc/stat", fmt.Sprintf("cpu 0 0 0 %d\n", 200+i*100))
		h.Sample(time.Unix(1005+int64(i)*5, 0))
	}
	data, err := json.Marshal(h.Samples())
	if err != nil {
		t.Fatal(err)
	}
	var samples []map[string]any
	if err := json.Unmarshal(data, &samples); err != nil {
		t.Fatal(err)
	}
	want := []any{nil, float64(43), float64(0), float64(100), nil, nil, nil, nil, nil, float64(72)}
	if len(samples) != len(want) {
		t.Fatalf("got %d samples, want %d", len(samples), len(want))
	}
	for i, sample := range samples {
		got, present := sample["gpu"]
		if !present || got != want[i] {
			t.Errorf("sample %d gpu = %v (present %v), want %v", i, got, present, want[i])
		}
	}
}

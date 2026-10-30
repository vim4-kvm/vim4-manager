package board

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func gpuFixtureWrite(t *testing.T, root, path, value string) {
	t.Helper()
	full := filepath.Join(root, path)
	if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(value), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestGPUSnapshotDiscoveryAndRecovery(t *testing.T) {
	root := t.TempDir()
	if got, err := readGPUSnapshot(root); err != nil || got != nil {
		t.Fatal(got, err)
	}
	profile := "sys/bus/platform/drivers/panfrost/gpu/profiling"
	gpuFixtureWrite(t, root, profile, "0")
	if got, err := readGPUSnapshot(root); err != nil || got != nil {
		t.Fatal(got, err)
	}
	data, _ := os.ReadFile(filepath.Join(root, profile))
	if string(data) != "1\n" {
		t.Fatal("profiling not enabled")
	}
	fd := func(pid, number, id int, busy uint64, driver string) {
		t.Helper()
		gpuFixtureWrite(t, root, fmt.Sprintf("proc/%d/fdinfo/%d", pid, number),
			fmt.Sprintf("drm-driver: %s\ndrm-client-id: %d\ndrm-engine-fragment: %d ns\ndrm-engine-vertex-tiler: 0 ns\n", driver, id, busy))
		path := filepath.Join(root, fmt.Sprintf("proc/%d/fd/%d", pid, number))
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("/dev/dri/renderD128", path); err != nil {
			t.Fatal(err)
		}
	}
	fd(100, 3, 42, 100, "panfrost")
	fd(200, 4, 42, 120, "panfrost")
	fd(200, 5, 43, 200, "panfrost")
	fd(300, 3, 99, 999, "other")
	read := func() *gpuSnapshot {
		t.Helper()
		got, err := readGPUSnapshot(root)
		if err != nil || got == nil {
			t.Fatalf("snapshot %v: %v", got, err)
		}
		return got
	}
	got := read()
	if len(got.Clients) != 2 || got.Clients["42"]["fragment"] != 120 || got.Clients["43"]["fragment"] != 200 {
		t.Fatal(got)
	}
	gpuFixtureWrite(t, root, "proc/100/fdinfo/3", "drm-driver: panfrost\ndrm-client-id: 42\n")
	if _, err := readGPUSnapshot(root); err == nil {
		t.Fatal("malformed counters accepted")
	}
	if err := os.Remove(filepath.Join(root, "proc/100/fdinfo/3")); err != nil {
		t.Fatal(err)
	}
	if read().Clients["42"]["fragment"] != 120 {
		t.Fatal("closed fd prevented recovery")
	}
	if err := os.Remove(filepath.Join(root, profile)); err != nil {
		t.Fatal(err)
	}
	if got, err := readGPUSnapshot(root); err != nil || got != nil {
		t.Fatal(got, err)
	}
	gpuFixtureWrite(t, root, profile, "1")
	read()
	// A non-link entry is an observable read error, not proof of idle.
	gpuFixtureWrite(t, root, "proc/100/fd/9", "invalid")
	if _, err := readGPUSnapshot(root); err == nil {
		t.Fatal("scan failure reported as idle")
	}
}

func TestGPUSnapshotSkipsUnrelatedFDInfo(t *testing.T) {
	root := t.TempDir()
	gpuFixtureWrite(t, root, "sys/bus/platform/drivers/panfrost/gpu/profiling", "1")
	dir := filepath.Join(root, "proc/100/fd")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 1000; i++ {
		if err := os.Symlink("socket:[1234]", filepath.Join(dir, fmt.Sprint(i))); err != nil {
			t.Fatal(err)
		}
	}
	// Any fdinfo open would return EISDIR and fail this scan.
	if err := os.MkdirAll(filepath.Join(root, "proc/100/fdinfo/0"), 0755); err != nil {
		t.Fatal(err)
	}
	got, err := readGPUSnapshot(root)
	if err != nil || got == nil || len(got.Clients) != 0 {
		t.Fatal(got, err)
	}
}

// Used only by deploy/benchmark_gpu.py; no fixture path enters the installed API.
func TestGPUSnapshotBenchmarkProbe(t *testing.T) {
	if root := os.Getenv("VIM4_GPU_BENCH_ROOT"); root != "" {
		if _, err := readGPUSnapshot(root); err != nil {
			t.Fatal(err)
		}
	}
}

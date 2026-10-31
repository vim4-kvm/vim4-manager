package board

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// This existing r44p0 debugfs file reads cached PM counters only. It neither
// consumes devfreq's window nor accesses GPU MMIO. Traversal needs root.
func readKbaseSnapshot(root string) (*gpuSnapshot, bool, error) {
	devices, err := filepath.Glob(filepath.Join(root, "sys/bus/platform/drivers/mali/*.gpu"))
	if err != nil || len(devices) == 0 {
		return nil, false, err
	}
	if len(devices) != 1 {
		return nil, true, nil
	}
	device, err := filepath.EvalSymlinks(devices[0])
	if err != nil {
		return nil, true, err
	}
	nodes, err := filepath.Glob(filepath.Join(root, "sys/kernel/debug/mali*/dvfs_utilization"))
	if err != nil || len(nodes) != 1 {
		return nil, true, err
	}
	data, err := os.ReadFile(nodes[0])
	if err != nil {
		return nil, true, err
	}
	fields := strings.Fields(string(data))
	if len(fields) != 4 || fields[0] != "busy_time:" || fields[2] != "idle_time:" {
		return nil, true, fmt.Errorf("invalid kbase JM metrics")
	}
	busy, busyErr := strconv.ParseUint(fields[1], 10, 32)
	idle, idleErr := strconv.ParseUint(fields[3], 10, 32)
	if busyErr != nil || idleErr != nil {
		return nil, true, fmt.Errorf("invalid kbase JM counters")
	}
	var now unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_MONOTONIC, &now); err != nil {
		return nil, true, err
	}
	return &gpuSnapshot{Device: device, TimeNS: now.Nano(), Kbase: &kbaseMetrics{
		Busy: uint32(busy), Idle: uint32(idle),
	}}, true, nil
}

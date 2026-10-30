package board

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// WriteGPUSnapshot is the argument-free privileged query used by the helper.
// It never opens a GPU device or accepts a caller-selected filesystem root.
func WriteGPUSnapshot(output io.Writer) error {
	snapshot, err := readGPUSnapshot("/")
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(snapshot)
}

func processDisappeared(err error) bool {
	return os.IsNotExist(err) || errors.Is(err, syscall.ESRCH)
}

func decimal(value string) bool {
	if value == "" {
		return false
	}
	for _, ch := range value {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}

func drmNode(target string) bool {
	name, ok := strings.CutPrefix(target, "/dev/dri/")
	if !ok {
		return false
	}
	for _, prefix := range []string{"renderD", "card"} {
		if suffix, ok := strings.CutPrefix(name, prefix); ok && decimal(suffix) {
			return true
		}
	}
	return false
}

func readGPUSnapshot(root string) (*gpuSnapshot, error) {
	nodes, err := filepath.Glob(filepath.Join(root, "sys/bus/platform/drivers/panfrost/*/profiling"))
	if err != nil || len(nodes) != 1 {
		return nil, err
	}
	profiling := nodes[0]
	data, err := os.ReadFile(profiling)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(string(data)) != "1" {
		return nil, os.WriteFile(profiling, []byte("1\n"), 0)
	}
	var now unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_MONOTONIC, &now); err != nil {
		return nil, err
	}
	device, err := filepath.EvalSymlinks(filepath.Dir(profiling))
	if err != nil {
		return nil, err
	}
	snapshot := &gpuSnapshot{Device: device, TimeNS: now.Nano(), Clients: map[string]map[string]uint64{}}
	processes, err := os.ReadDir(filepath.Join(root, "proc"))
	if err != nil {
		return nil, err
	}
	for _, process := range processes {
		if !decimal(process.Name()) {
			continue
		}
		base := filepath.Join(root, "proc", process.Name())
		fds, err := os.ReadDir(filepath.Join(base, "fd"))
		if processDisappeared(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, fd := range fds {
			target, err := os.Readlink(filepath.Join(base, "fd", fd.Name()))
			if processDisappeared(err) {
				continue
			}
			if err != nil {
				return nil, err
			}
			if !drmNode(target) {
				continue
			}
			data, err := os.ReadFile(filepath.Join(base, "fdinfo", fd.Name()))
			if processDisappeared(err) {
				continue
			}
			if err != nil {
				return nil, err
			}
			id, engines, err := parseGPUClient(string(data))
			if err != nil {
				return nil, err
			}
			if engines == nil {
				continue
			}
			old := snapshot.Clients[id]
			for name, count := range engines {
				engines[name] = max(count, old[name])
			}
			snapshot.Clients[id] = engines
		}
	}
	data, err = os.ReadFile(profiling)
	if err != nil || strings.TrimSpace(string(data)) != "1" {
		return nil, err
	}
	return snapshot, nil
}

func parseGPUClient(data string) (string, map[string]uint64, error) {
	fields := map[string]string{}
	for _, line := range strings.Split(data, "\n") {
		key, value, ok := strings.Cut(line, ":")
		if ok {
			fields[key] = strings.TrimSpace(value)
		}
	}
	if fields["drm-driver"] != "panfrost" {
		return "", nil, nil
	}
	id := fields["drm-client-id"]
	if !decimal(id) {
		return "", nil, fmt.Errorf("missing Panfrost client identity")
	}
	engines := map[string]uint64{}
	for _, name := range []string{"fragment", "vertex-tiler"} {
		value := strings.Fields(fields["drm-engine-"+name])
		if len(value) != 2 || value[1] != "ns" || !decimal(value[0]) {
			return "", nil, fmt.Errorf("missing Panfrost engine counter")
		}
		counter, err := strconv.ParseUint(value[0], 10, 64)
		if err != nil {
			return "", nil, fmt.Errorf("invalid Panfrost engine counter")
		}
		engines[name] = counter
	}
	return id, engines, nil
}

package board

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Sample is one point of the dashboard trend charts.
type Sample struct {
	UnixMs int64   `json:"t"`
	CPU    float64 `json:"cpu"`
	// Null means unavailable; zero is a valid idle dynamic-power estimate.
	CPUPowerW *float64 `json:"cpuPowerW"`
	Mem       float64  `json:"mem"`
	TempC     float64  `json:"tempC"`
	FanPct    int      `json:"fan"`
	// Physical-link throughput since the previous sample, in bits per second.
	RxBps float64 `json:"rxBps"`
	TxBps float64 `json:"txBps"`
}

// History keeps recent samples in memory; it restarts empty with the service.
type History struct {
	Root     string
	Capacity int
	Execute  Runner

	mu       sync.Mutex
	samples  []Sample
	busy     uint64
	total    uint64
	rx, tx   uint64
	last     time.Time
	cpuPower []cpuPowerDomain
}

// Run samples every interval until ctx is cancelled.
func (h *History) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	h.Sample(time.Now())
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			h.Sample(now)
		}
	}
}

// Sample records one point. CPU use needs two /proc/stat readings, so the
// first call only primes the counters.
func (h *History) Sample(now time.Time) {
	read := func(path string) string {
		data, _ := os.ReadFile(filepath.Join(h.Root, path))
		return strings.TrimSpace(string(data))
	}
	busy, total := cpuTimes(read("proc/stat"))
	s := Sample{UnixMs: now.UnixMilli()}
	if total, avail := memInfo(read("proc/meminfo")); total > 0 {
		s.Mem = 100 * float64(total-avail) / float64(total)
	}
	if milli, err := strconv.Atoi(read("sys/class/thermal/thermal_zone0/temp")); err == nil {
		s.TempC = float64(milli) / 1000
	}
	s.FanPct, _ = strconv.Atoi(afterColon(read("sys/class/fan/speed")))
	rx, tx := netBytes(h.Root)
	currentPower := readCPUPowerSnapshot(h.Execute)

	h.mu.Lock()
	defer h.mu.Unlock()
	s.CPUPowerW = estimateCPUPower(h.cpuPower, currentPower)
	h.cpuPower = currentPower
	primed := h.total > 0 && total > h.total
	if primed {
		s.CPU = 100 * float64(busy-h.busy) / float64(total-h.total)
		// Counters restart when an interface is re-created; skip that interval.
		if seconds := now.Sub(h.last).Seconds(); seconds > 0 && rx >= h.rx && tx >= h.tx {
			s.RxBps = 8 * float64(rx-h.rx) / seconds
			s.TxBps = 8 * float64(tx-h.tx) / seconds
		}
	}
	h.busy, h.total, h.rx, h.tx, h.last = busy, total, rx, tx, now
	if !primed {
		return
	}
	h.samples = append(h.samples, s)
	if over := len(h.samples) - h.Capacity; over > 0 {
		h.samples = append(h.samples[:0], h.samples[over:]...)
	}
}

// Samples returns a copy, oldest first.
func (h *History) Samples() []Sample {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]Sample{}, h.samples...)
}

// cpuTimes sums the aggregate "cpu" line of /proc/stat. Idle and iowait count
// as not busy; guest time is already included in user and nice.
func cpuTimes(stat string) (busy, total uint64) {
	line, _, _ := strings.Cut(stat, "\n")
	fields := strings.Fields(line)
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0, 0
	}
	for i, field := range fields[1:min(len(fields), 9)] {
		n, _ := strconv.ParseUint(field, 10, 64)
		total += n
		if i != 3 && i != 4 {
			busy += n
		}
	}
	return busy, total
}

// memInfo returns MemTotal and MemAvailable in KiB.
func memInfo(meminfo string) (total, avail int64) {
	for _, line := range strings.Split(meminfo, "\n") {
		key, value, _ := strings.Cut(line, ":")
		kib, _ := strconv.ParseInt(strings.TrimSuffix(strings.TrimSpace(value), " kB"), 10, 64)
		switch key {
		case "MemTotal":
			total = kib
		case "MemAvailable":
			avail = kib
		}
	}
	return total, avail
}

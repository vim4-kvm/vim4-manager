package board

import (
	"context"
	"encoding/json"
	"time"
)

type cpuCounters struct {
	Busy  uint64 `json:"busy"`
	Total uint64 `json:"total"`
}

type cpuPowerState struct {
	Ticks      uint64  `json:"ticks"`
	Milliwatts float64 `json:"milliwatts"`
}

type cpuPowerDomain struct {
	CPUs   map[string]cpuCounters   `json:"cpus"`
	States map[string]cpuPowerState `json:"states"`
}

func readCPUPowerSnapshot(run Runner) []cpuPowerDomain {
	if run == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	data, err := run(ctx, "sudo", "-n", Helper, "cpu-power-snapshot")
	var domains []cpuPowerDomain
	if err != nil || json.Unmarshal([]byte(data), &domains) != nil {
		return nil
	}
	return domains
}

// estimateCPUPower combines frequency residency with each core's busy fraction.
// Their correlation within the interval is unknown; this is an approximation of
// dynamic CPU power only, excluding leakage and other SoC/board components.
// Missing data, hotplug, model changes and counter resets invalidate an interval.
func estimateCPUPower(previous, current []cpuPowerDomain) *float64 {
	if len(current) == 0 || len(previous) != len(current) {
		return nil
	}
	watts := 0.0
	for i, domain := range current {
		old := previous[i]
		if len(domain.CPUs) == 0 || len(domain.CPUs) != len(old.CPUs) || len(domain.States) != len(old.States) {
			return nil
		}
		busyCores := 0.0
		for cpu, counter := range domain.CPUs {
			before, ok := old.CPUs[cpu]
			if !ok || counter.Total <= before.Total || counter.Busy < before.Busy {
				return nil
			}
			busy, total := counter.Busy-before.Busy, counter.Total-before.Total
			if busy > total {
				return nil
			}
			busyCores += float64(busy) / float64(total)
		}
		weighted, ticks := 0.0, uint64(0)
		for frequency, state := range domain.States {
			before, ok := old.States[frequency]
			if !ok || state.Ticks < before.Ticks || state.Milliwatts <= 0 || state.Milliwatts != before.Milliwatts {
				return nil
			}
			delta := state.Ticks - before.Ticks
			ticks += delta
			weighted += float64(delta) * state.Milliwatts
		}
		if ticks == 0 {
			return nil
		}
		watts += weighted / float64(ticks) * busyCores / 1000
	}
	return &watts
}

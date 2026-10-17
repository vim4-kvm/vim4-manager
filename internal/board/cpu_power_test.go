package board

import (
	"encoding/json"
	"math"
	"testing"
)

func TestEstimateCPUPowerWeightsResidencyAndIndividualCores(t *testing.T) {
	before := []cpuPowerDomain{
		{CPUs: map[string]cpuCounters{"0": {100, 1000}, "1": {100, 1000}}, States: map[string]cpuPowerState{"500000": {20, 200}, "1000000": {80, 800}}},
		{CPUs: map[string]cpuCounters{"4": {100, 1000}}, States: map[string]cpuPowerState{"1000000": {100, 100}}},
	}
	after := []cpuPowerDomain{
		{CPUs: map[string]cpuCounters{"0": {150, 1100}, "1": {200, 1100}}, States: map[string]cpuPowerState{"500000": {45, 200}, "1000000": {155, 800}}},
		{CPUs: map[string]cpuCounters{"4": {120, 1100}}, States: map[string]cpuPowerState{"1000000": {200, 100}}},
	}
	// A73: (0.25*200 + 0.75*800) * (0.5+1) mW; A53: 100*0.2 mW.
	if got := estimateCPUPower(before, after); got == nil || math.Abs(*got-0.995) > 1e-9 {
		t.Fatal(got)
	}
	for name, invalidate := range map[string]func([]cpuPowerDomain){
		"counter reset":   func(d []cpuPowerDomain) { d[0].CPUs["0"] = cpuCounters{0, 1} },
		"hotplug":         func(d []cpuPowerDomain) { delete(d[0].CPUs, "1") },
		"residency reset": func(d []cpuPowerDomain) { d[0].States["500000"] = cpuPowerState{0, 200} },
		"changed model":   func(d []cpuPowerDomain) { d[0].States["500000"] = cpuPowerState{45, 300} },
		"missing domain":  func(d []cpuPowerDomain) { d[1].CPUs = nil },
	} {
		t.Run(name, func(t *testing.T) {
			data, _ := json.Marshal(after)
			var changed []cpuPowerDomain
			_ = json.Unmarshal(data, &changed)
			invalidate(changed)
			if estimateCPUPower(before, changed) != nil {
				t.Fatal("invalid interval reported as watts")
			}
		})
	}
	if estimateCPUPower(nil, after) != nil || estimateCPUPower(before, nil) != nil {
		t.Fatal("missing sample")
	}
	for i := range after {
		for cpu, counter := range after[i].CPUs {
			counter.Busy = before[i].CPUs[cpu].Busy
			after[i].CPUs[cpu] = counter
		}
	}
	if got := estimateCPUPower(before, after); got == nil || *got != 0 {
		t.Fatal("idle is a valid zero", got)
	}
}

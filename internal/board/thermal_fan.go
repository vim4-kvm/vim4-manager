package board

import (
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

func thermalRead(path string) string {
	data, _ := os.ReadFile(path)
	return strings.TrimSpace(string(data))
}

func thermalFanDevice(root string) string {
	devices, _ := filepath.Glob(filepath.Join(root, "sys/class/thermal/cooling_device*"))
	for _, device := range devices {
		if thermalRead(filepath.Join(device, "type")) == "khadas-mcu-fan" {
			return device
		}
	}
	return ""
}

// thermalFanCurve reads only trips linked to the fan. Their numeric order is
// the board DT's ascending duty order, independent of CPU protection trips.
// An incomplete or inconsistent six-zone configuration cannot be edited.
func thermalFanCurve(root, device string) ([]CurvePoint, *FanTriggers, bool) {
	zones, _ := filepath.Glob(filepath.Join(root, "sys/class/thermal/thermal_zone*"))
	var temperatures []int
	count, automatic := 0, true
	for _, zone := range zones {
		kind := thermalRead(filepath.Join(zone, "type"))
		if !slices.Contains([]string{"a73-thermal", "a53-thermal", "gpu-thermal", "nna-thermal", "vpu-thermal", "hevc-thermal"}, kind) {
			continue
		}
		count++
		automatic = automatic && thermalRead(filepath.Join(zone, "policy")) == "step_wise" && thermalRead(filepath.Join(zone, "mode")) == "enabled"
		links, _ := filepath.Glob(filepath.Join(zone, "cdev*"))
		var ids []int
		for _, link := range links {
			target, err := filepath.EvalSymlinks(link)
			fan, _ := filepath.EvalSymlinks(device)
			if err != nil || target != fan {
				continue
			}
			id, err := strconv.Atoi(thermalRead(link + "_trip_point"))
			if err == nil {
				ids = append(ids, id)
			}
		}
		slices.Sort(ids)
		ids = slices.Compact(ids)
		if len(ids) != 15 {
			return nil, nil, false
		}
		var values []int
		for _, id := range ids {
			base := filepath.Join(zone, "trip_point_"+strconv.Itoa(id))
			value, err := strconv.Atoi(thermalRead(base + "_temp"))
			if err != nil || thermalRead(base+"_type") != "active" {
				return nil, nil, false
			}
			values = append(values, value)
		}
		if temperatures != nil && !slices.Equal(temperatures, values) {
			return nil, nil, automatic
		}
		temperatures = values
	}
	if count != 6 {
		return nil, nil, false
	}
	curve := make([]CurvePoint, 15)
	for i, duty := range []int{5, 10, 15, 20, 25, 30, 35, 43, 52, 61, 70, 77, 85, 92, 100} {
		curve[i] = CurvePoint{TempC: float64(temperatures[i]) / 1000, Percent: duty}
	}
	return curve, &FanTriggers{Low: temperatures[6] / 1000, Mid: temperatures[10] / 1000, High: temperatures[14] / 1000}, automatic
}

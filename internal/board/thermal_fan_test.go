package board

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestThermalFanNumberingAndPartialConfiguration(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "sys/class/thermal")
	write := func(path, value string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(value), 0644); err != nil {
			t.Fatal(err)
		}
	}
	fan := filepath.Join(base, "cooling_device23")
	write(filepath.Join(fan, "type"), "khadas-mcu-fan")
	write(filepath.Join(fan, "cur_state"), "43")
	write(filepath.Join(root, "proc/sys/kernel/osrelease"), "7.3.0")
	for n, kind := range []string{"a73", "a53", "gpu", "nna", "vpu", "hevc"} {
		zone := filepath.Join(base, fmt.Sprintf("thermal_zone%d", n+9))
		write(filepath.Join(zone, "type"), kind+"-thermal")
		write(filepath.Join(zone, "temp"), fmt.Sprint(40000+n*1000))
		write(filepath.Join(zone, "mode"), "enabled")
		write(filepath.Join(zone, "policy"), "step_wise")
		for i, temp := range []int{45000, 47500, 50000, 52500, 55000, 57500, 60000, 65000, 70000, 75000, 80000, 85000, 90000, 95000, 100000} {
			link := filepath.Join(zone, fmt.Sprintf("cdev%d", 20-i))
			if err := os.Symlink(fan, link); err != nil {
				t.Fatal(err)
			}
			write(link+"_trip_point", fmt.Sprint(i+3))
			write(filepath.Join(zone, fmt.Sprintf("trip_point_%d_type", i+3)), "active")
			write(filepath.Join(zone, fmt.Sprintf("trip_point_%d_temp", i+3)), fmt.Sprint(temp))
		}
	}
	h := ReadHardware(root)
	if h.FanPct != 43 || h.TempC != 45 || !h.FanAuto || h.FanTriggers == nil || *h.FanTriggers != DefaultFanTriggers || len(h.FanCurve) != 15 {
		t.Fatalf("standard fan: %+v", h)
	}
	write(filepath.Join(base, "thermal_zone9/trip_point_9_temp"), "65000")
	if h = ReadHardware(root); h.FanTriggers != nil {
		t.Fatal("inconsistent zones exposed as an editable saved curve")
	}
}

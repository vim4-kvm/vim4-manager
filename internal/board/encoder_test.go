package board

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEncoderQuarantineDoesNotTurnMissingStateIntoHealthy(t *testing.T) {
	root := t.TempDir()
	if got := readEncoder(root); got.Known || got.Isolated {
		t.Fatalf("missing driver: %+v", got)
	}
	dir := filepath.Join(root, "sys/bus/platform/drivers/vdec/fe000000.codec")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	write := func(name, value string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(value), 0644); err != nil {
			t.Fatal(err)
		}
	}
	write("isolated", "invalid\n")
	if readEncoder(root).Known {
		t.Fatal("invalid sysfs state reported healthy")
	}
	write("isolated", "0\n")
	if got := readEncoder(root); !got.Known || got.Isolated || got.NeedsReboot {
		t.Fatalf("healthy: %+v", got)
	}
	write("isolation_reason", "command acknowledgement timeout\n")
	write("isolation_time_ns", "9007199254740993\n")
	write("isolated", "1\n")
	if got := readEncoder(root); !got.Known || !got.Isolated || !got.NeedsReboot ||
		got.Reason != "command acknowledgement timeout" || got.TimeNS != "9007199254740993" {
		t.Fatalf("isolated: %+v", got)
	}
}

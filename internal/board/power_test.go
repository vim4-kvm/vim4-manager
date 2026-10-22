package board

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestPowerFailureClearsPreviousReading(t *testing.T) {
	calls := 0
	s := &Service{Run: func(context.Context, string, ...string) (string, error) {
		calls++
		if calls == 1 {
			return `{"vbusPresent":true,"bootContract":{"voltageV":5,"currentA":3},"firmwarePD":{"psReady":true,"contract":{"voltageV":5,"currentA":1},"sourceCapabilities":[{"position":1,"type":"Fixed","raw":"3e01912c","maxCurrentA":3}]}}`, nil
		}
		return "", errors.New("controller busy")
	}}
	if p := s.power(context.Background()); p.VBUSPresent == nil || !*p.VBUSPresent || p.FirmwarePD == nil || p.FirmwarePD.Contract.CurrentA != 1 || *p.FirmwarePD.SourceCapabilities[0].MaxCurrentA != 3 {
		t.Fatal(p)
	}
	s.power(context.Background())
	if calls != 1 {
		t.Fatal("cache did not suppress repeated hardware access")
	}
	s.powerAt = time.Time{}
	if p := s.power(context.Background()); p.VBUSPresent != nil || p.BootContract != nil || p.FirmwarePD != nil {
		t.Fatal("stale reading survived failure", p)
	}
}

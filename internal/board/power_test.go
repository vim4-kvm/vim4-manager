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

func TestPowerLastContract(t *testing.T) {
	s := &Service{Run: func(context.Context, string, ...string) (string, error) {
		return `{"vbusPresent":true,"lastContract":{"voltageV":5,"currentA":3,"usbComm":true,"rdo":"1304b12c","origin":"linux","bootId":"previous-boot","establishedAt":"2026-10-22T12:00:00+08:00"}}`, nil
	}}
	p := s.power(context.Background())
	last := p.LastContract
	if last == nil || last.VoltageV != 5 || last.CurrentA != 3 || !last.USBComm || last.RDO != "1304b12c" || last.Origin != "linux" || last.BootID != "previous-boot" || last.EstablishedAt != "2026-10-22T12:00:00+08:00" {
		t.Fatal("lost cross-boot contract metadata", last)
	}
	s.powerAt = time.Time{}
	s.Run = func(context.Context, string, ...string) (string, error) { return "invalid", nil }
	if s.power(context.Background()).LastContract != nil {
		t.Fatal("stale history survived malformed helper output")
	}
}

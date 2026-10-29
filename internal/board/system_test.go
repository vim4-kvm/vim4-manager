package board

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/i18n"
)

func TestParseAddrsKeepsGlobalAddressesIPv4First(t *testing.T) {
	// Captured from the board with `ip -o addr show`, trimmed.
	output := `1: lo    inet 127.0.0.1/8 scope host lo\       valid_lft forever preferred_lft forever
2: eth0    inet 192.168.50.210/24 brd 192.168.50.255 scope global dynamic noprefixroute eth0\       valid_lft 85000sec preferred_lft 85000sec
2: eth0    inet6 240e:3ba:34af:db90:9a0b:66ba:7e07:b1e3/64 scope global temporary dynamic \       valid_lft 600sec preferred_lft 600sec
2: eth0    inet6 240e:3ba:34af:db90:34f9:1f96:7b92:ddad/64 scope global dynamic mngtmpaddr noprefixroute \       valid_lft 600sec preferred_lft 600sec
2: eth0    inet6 fe80::8591:e477:7943:ea47/64 scope link noprefixroute \       valid_lft forever preferred_lft forever
`
	got := parseAddrs(output)
	want := []string{"192.168.50.210", "240e:3ba:34af:db90:34f9:1f96:7b92:ddad"}
	if !slices.Equal(got["eth0"], want) || got["lo"] != nil {
		t.Errorf("addrs = %v", got)
	}
}

func TestInstalledPackagesListsOnlyInstalledComponents(t *testing.T) {
	status := "Package: vim4-manager\nStatus: install ok installed\nVersion: 2.5.1+vim4.1\n\n" +
		"Package: vim4-jetkvm\nStatus: deinstall ok config-files\nVersion: 2.5.1+vim4.0\n\n" +
		"Package: bash\nStatus: install ok installed\nVersion: 5.2\n\n" +
		"Package: vim4-amlvenc\nStatus: install ok installed\nVersion: 2.5.1+vim4.2"
	got := installedPackages(status)
	want := []Package{{"vim4-amlvenc", "2.5.1+vim4.2"}, {"vim4-manager", "2.5.1+vim4.1"}}
	if !slices.Equal(got, want) {
		t.Errorf("packages = %v", got)
	}
}

func TestLinksAndThroughputUsePhysicalInterfaces(t *testing.T) {
	root := t.TempDir()
	iface := func(name string, device, wireless bool, state, speed string, rx, tx string) {
		dir := filepath.Join(root, "sys/class/net", name)
		_ = os.MkdirAll(filepath.Join(dir, "statistics"), 0o755)
		if device {
			_ = os.Mkdir(filepath.Join(dir, "device"), 0o755)
		}
		if wireless {
			_ = os.Mkdir(filepath.Join(dir, "wireless"), 0o755)
		}
		_ = os.WriteFile(filepath.Join(dir, "operstate"), []byte(state+"\n"), 0o644)
		if speed != "" {
			_ = os.WriteFile(filepath.Join(dir, "speed"), []byte(speed+"\n"), 0o644)
		}
		_ = os.WriteFile(filepath.Join(dir, "statistics/rx_bytes"), []byte(rx), 0o644)
		_ = os.WriteFile(filepath.Join(dir, "statistics/tx_bytes"), []byte(tx), 0o644)
	}
	iface("eth0", true, false, "up", "1000", "1000", "5000")
	iface("wlan0", true, true, "down", "-1", "100", "100")
	iface("usb0", true, false, "down", "", "0", "0")
	iface("lo", false, false, "unknown", "", "999999", "999999")
	links := readLinks(root, map[string][]string{"eth0": {"192.168.50.210"}})
	want := []Link{{Name: "eth0", Up: true, SpeedMb: 1000, Addrs: []string{"192.168.50.210"}}, {Name: "wlan0", Wireless: true}}
	if len(links) != 2 || links[0].Name != want[0].Name || links[0].SpeedMb != 1000 || !links[1].Wireless || links[1].SpeedMb != 0 {
		t.Errorf("links = %+v", links)
	}
	if rx, tx := netBytes(root); rx != 1100 || tx != 5100 {
		t.Errorf("bytes = %d %d, lo must be excluded", rx, tx)
	}
}

func TestEventsKeepNewestFirstWithinCapacity(t *testing.T) {
	clock := time.Unix(100, 0)
	e := &Events{Capacity: 2, now: func() time.Time { clock = clock.Add(time.Second); return clock }}
	e.Add("good", "a")
	e.Add("good", "b %d", 2)
	e.Add("good", "c")
	got := e.List()
	if len(got) != 2 || got[0].Text != "c" || got[1].Text != "b 2" || got[0].UnixMs != 103000 {
		t.Errorf("events = %+v", got)
	}
	var none *Events
	none.Add("good", "ignored")
	if none.List() == nil {
		t.Error("nil list must encode as []")
	}
}

func TestCompareReportsTransitionsOnce(t *testing.T) {
	s := &Service{Events: &Events{Capacity: 20}}
	signal := HDMI{Signal: true, Width: 3840, Height: 2160, RefreshHz: 59.99, HDR: "SDR"}
	app := func(active string) map[string]Unit {
		return map[string]Unit{"one-kvm.service": {Loaded: true, Active: active, Sub: "running"}}
	}
	steps := []*snapshot{
		{hdmi: signal, usb: "configured", tempC: 50, units: app("active")},
		{hdmi: HDMI{}, usb: "configured", tempC: 86, units: app("active")},
		{hdmi: HDMI{}, usb: "configured", tempC: 82, units: app("active")},
		{hdmi: signal, usb: "suspended", tempC: 79, units: app("failed")},
	}
	for i := 1; i < len(steps); i++ {
		s.compare(steps[i-1], steps[i])
	}
	var texts []string
	for _, e := range s.Events.List() {
		texts = append(texts, e.Text)
	}
	slices.Reverse(texts)
	want := []string{"HDMI signal lost", "SoC temperature exceeded 85 °C", "HDMI signal restored: 3840×2160@60",
		"USB keyboard and mouse disconnected (suspended)", "SoC temperature fell to 79 °C", "One-KVM failed"}
	if !slices.Equal(texts, want) {
		t.Errorf("events = %q", texts)
	}
}

func TestRecordLogsActionOutcomeButNotBusy(t *testing.T) {
	s := &Service{Events: &Events{Capacity: 5}}
	_ = s.recordMessage(nil, i18n.Message{Key: "events.appSelected", Args: map[string]any{"p0": "PiKVM"}})
	_ = s.recordMessage(errors.New("x"), i18n.Message{Key: "events.serviceRestarted", Args: map[string]any{"p0": unitName("vim4-kvm-hdmi.service")}})
	_ = s.recordMessage(ErrBusy, i18n.Message{Key: "events.appSelected", Args: map[string]any{"p0": "ignored"}})
	got := s.Events.List()
	if len(got) != 2 || got[0].Text != "Restart HDMI capture failed" || got[0].Tone != "critical" || got[1].Text != "Switch to PiKVM" {
		t.Errorf("events = %+v", got)
	}
	zh := s.Events.List(i18n.Chinese)
	if len(zh) != 2 || zh[0].Text != "重启HDMI 采集失败" || zh[1].Text != "切换到 PiKVM" {
		t.Errorf("Chinese events = %+v", zh)
	}
}

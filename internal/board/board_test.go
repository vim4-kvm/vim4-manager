package board

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestQueryUnitsMapsMissingUnitsByPosition(t *testing.T) {
	// Captured from systemd 255: a missing unit still yields a block, with an
	// Id that matches the request, so position is what pairs blocks to names.
	output := "Id=nanokvm.service\nLoadState=loaded\nActiveState=active\nSubState=running\n" +
		"UnitFileState=enabled\nActiveEnterTimestamp=@1791000000\n\n" +
		"Id=vim4-kvm.service\nLoadState=not-found\nActiveState=inactive\nSubState=dead\n" +
		"UnitFileState=\nActiveEnterTimestamp=\n"
	run := func(context.Context, string, ...string) (string, error) { return output, nil }
	units, err := QueryUnits(context.Background(), run, []string{"nanokvm.service", "vim4-kvm.service"})
	if err != nil {
		t.Fatal(err)
	}
	if u := units["nanokvm.service"]; !u.Loaded || u.Active != "active" || u.Enabled != "enabled" || u.ActiveFor == nil {
		t.Errorf("nanokvm = %+v", u)
	}
	if u := units["vim4-kvm.service"]; u.Loaded || u.ActiveFor != nil {
		t.Errorf("missing unit = %+v", u)
	}
	if _, err := QueryUnits(context.Background(), run, []string{"nanokvm.service"}); err == nil {
		t.Error("block count mismatch accepted")
	}
}

func TestHDMIInfoFromBoard(t *testing.T) {
	info, err := os.ReadFile("testdata/hdmirx-4k60.txt")
	if err != nil {
		t.Fatal(err)
	}
	h := parseHDMI(string(info))
	// The receiver prints Hactive 1920 for 4K YUV420.
	if !h.Signal || h.Width != 3840 || h.Height != 2160 || h.RefreshHz != 59.99 || h.ColorSpace != "YUV420" || !h.Audio {
		t.Errorf("parseHDMI = %+v", h)
	}
	if got := parseHDMI("port: 1\nHDMI info\n\nHactive: 0\nVactive: 0\nFrame Rate: 0\n"); got.Signal {
		t.Errorf("no signal parsed as %+v", got)
	}
}

func TestReadHardware(t *testing.T) {
	root := t.TempDir()
	write := func(path, content string) {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("sys/class/thermal/thermal_zone0/temp", "52800\n")
	write("sys/class/fan/mode", "Fan mode: 1\n")
	write("sys/class/fan/speed", "Fan speed: 15\n")
	write("sys/class/udc/fdd00000.crgudc2/state", "configured\n")
	write("proc/meminfo", "MemTotal:        7990828 kB\nMemAvailable:    6775820 kB\n")
	write("etc/default/vim4-kvm-hdmi", "HDMI_WIDTH=1920\nHDMI_HEIGHT=\"1080\"\n")
	h := ReadHardware(root)
	if h.TempC != 52.8 || !h.FanAuto || h.FanPct != 15 || h.USB != "configured" || h.MemAvail != 6775820 {
		t.Errorf("ReadHardware = %+v", h)
	}
	if h.HDMI.Signal || h.HDMI.CaptureW != 1920 || h.HDMI.CaptureH != 1080 {
		t.Errorf("HDMI = %+v", h.HDMI)
	}
	// Without an override the HDMI service captures at 4K.
	if w, hgt := captureSize(""); w != 3840 || hgt != 2160 {
		t.Errorf("default capture = %dx%d", w, hgt)
	}
	if h.HDRCurve != DefaultHDRCurve {
		t.Errorf("HDR curve without override = %+v", h.HDRCurve)
	}
}

func TestReadHardwareHDR(t *testing.T) {
	root := t.TempDir()
	write := func(path, content string) {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// The receiver keeps the last HDR state after the signal goes away.
	write("sys/class/hdmirx/hdmirx0/hdmi_hdr_status", "HDR10-GAMMA_ST2084")
	write("etc/default/vim4-kvm-hdr", "HDR_SDR_WHITE=250\n")
	h := ReadHardware(root)
	if h.HDMI.HDR != "" || h.HDRCurve != (HDRCurve{White: 250, Peak: 1000}) {
		t.Errorf("no signal: HDR = %q, curve = %+v", h.HDMI.HDR, h.HDRCurve)
	}
	info, err := os.ReadFile("testdata/hdmirx-4k60.txt")
	if err != nil {
		t.Fatal(err)
	}
	write("sys/class/hdmirx/hdmirx0/info", string(info))
	if got := ReadHardware(root).HDMI.HDR; got != "HDR10-GAMMA_ST2084" {
		t.Errorf("HDR = %q", got)
	}
}

func TestSetHDRCurveValidatesBeforeHelper(t *testing.T) {
	var calls []string
	s := &Service{Run: func(_ context.Context, name string, args ...string) (string, error) {
		calls = append(calls, name+" "+strings.Join(args, " "))
		return "", nil
	}}
	for _, curve := range []HDRCurve{{79, 1000}, {1001, 2000}, {203, 203}, {203, 10001}, {-1, 1000}} {
		if err := s.SetHDRCurve(context.Background(), curve); err == nil {
			t.Errorf("SetHDRCurve(%+v) accepted", curve)
		}
	}
	if len(calls) != 0 {
		t.Fatalf("rejected curves reached the helper: %v", calls)
	}
	if err := s.SetHDRCurve(context.Background(), HDRCurve{White: 203, Peak: 1000}); err != nil {
		t.Fatal(err)
	}
	if err := s.PreviewHDRCurve(context.Background(), HDRCurve{White: 180, Peak: 2000}); err != nil {
		t.Fatal(err)
	}
	want := []string{"sudo -n " + Helper + " hdr-curve 203 1000", "sudo -n " + Helper + " hdr-preview 180 2000"}
	if !slices.Equal(calls, want) {
		t.Errorf("calls = %v, want %v", calls, want)
	}
}

func TestServiceRejectsUnmanagedOperations(t *testing.T) {
	var calls []string
	s := &Service{Run: func(_ context.Context, name string, args ...string) (string, error) {
		calls = append(calls, name+" "+strings.Join(args, " "))
		return "", nil
	}}
	for _, unit := range []string{"vim4-kvm-gadget.service", "vim4-kvm-pd.service", "ssh.service", "nanokvm.service; reboot"} {
		if err := s.Restart(context.Background(), unit); err == nil {
			t.Errorf("Restart(%q) accepted", unit)
		}
	}
	if err := s.Select(context.Background(), "../nanokvm"); err == nil {
		t.Error("unknown app accepted")
	}
	if len(calls) != 0 {
		t.Fatalf("rejected requests reached the helper: %v", calls)
	}
	if err := s.Select(context.Background(), "jetkvm"); err != nil {
		t.Fatal(err)
	}
	if want := "sudo -n " + Helper + " select jetkvm"; len(calls) != 1 || calls[0] != want {
		t.Errorf("calls = %v, want %q", calls, want)
	}
}

func TestServiceSerializesOperations(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	s := &Service{Run: func(context.Context, string, ...string) (string, error) {
		close(entered)
		<-release
		return "", nil
	}}
	done := make(chan error)
	go func() { done <- s.Select(context.Background(), "nanokvm") }()
	<-entered
	if err := s.Restart(context.Background(), "nanokvm.service"); !errors.Is(err, ErrBusy) {
		t.Errorf("concurrent operation = %v, want ErrBusy", err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestStatusReportsEnabledAppAsSelected(t *testing.T) {
	var blocks []string
	for _, name := range allUnits() {
		state := "disabled"
		if name == "vim4-kvm.service" {
			state = "enabled"
		}
		// A failed but enabled app is still the boot selection.
		blocks = append(blocks, "Id="+name+"\nLoadState=loaded\nActiveState=failed\nUnitFileState="+state)
	}
	s := &Service{Root: t.TempDir(), Run: func(context.Context, string, ...string) (string, error) {
		return strings.Join(blocks, "\n\n") + "\n", nil
	}}
	status, err := s.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status.Active != "jetkvm" || len(status.Platform) != len(PlatformUnits) {
		t.Errorf("status = %+v", status)
	}
	for _, p := range status.Platform {
		if p.Restartable != (p.Unit.Name == "vim4-kvm-hdmi.service") {
			t.Errorf("%s restartable = %v", p.Unit.Name, p.Restartable)
		}
	}
}

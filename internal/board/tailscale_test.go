package board

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/vim4-kvm/vim4-manager/internal/i18n"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestNetworkHelperUpgradeCompatibility(t *testing.T) {
	for legacy, key := range i18n.NetworkHelperLegacy {
		for _, output := range []string{legacy, (i18n.Message{Key: key}).Render(i18n.English)} {
			cause := errors.New("sudo: " + output)
			err := networkHelperError(cause)
			if !errors.Is(err, cause) {
				t.Fatalf("lost cause for %q", output)
			}
			if got, want := i18n.RenderError(i18n.Chinese, err), (i18n.Message{Key: key}).Render(i18n.Chinese); got != want {
				t.Fatalf("%q: got %q, want %q", output, got, want)
			}
		}
	}
	if got := NetworkHelperText(i18n.English, "30 秒内未连接到已保存网络，已恢复热点"); got != "Couldn't connect to a saved network within 30 seconds. The hotspot was restored." {
		t.Fatal(got)
	}
	unknown := "NAS-文件: diagnostic from an external tool"
	if NetworkHelperText(i18n.Chinese, unknown) != unknown {
		t.Fatal("unknown diagnostics changed")
	}
}

func TestFeatureHelpersTranslateNestedOperationErrors(t *testing.T) {
	for _, test := range []struct {
		key string
		run func(*Service) error
	}{
		{"media.diskLocked", func(s *Service) error { return s.EjectMedia(context.Background(), "mounted") }},
		{"media.chooseRunningApp", func(s *Service) error {
			return s.MountMedia(context.Background(), "onekvm", "data/disk.img", false, false)
		}},
		{"updates.installVerificationFailed", func(s *Service) error { return networkHelperError(s.helper(context.Background(), "update")) }},
	} {
		message := i18n.Message{Key: test.key}
		outputs := []string{message.Render(i18n.English)}
		for _, legacy := range []map[string]string{i18n.StorageHelperLegacy, i18n.NetworkHelperLegacy} {
			for text, key := range legacy {
				if key == test.key {
					outputs = append(outputs, text)
				}
			}
		}
		for _, output := range outputs {
			cause := errors.New(output)
			service := &Service{Run: func(context.Context, string, ...string) (string, error) { return "", cause }}
			err := test.run(service)
			if !errors.Is(err, cause) || !strings.Contains(err.Error(), message.Render(i18n.English)) || !strings.Contains(i18n.RenderError(i18n.Chinese, err), message.Render(i18n.Chinese)) {
				t.Fatalf("%s %s: %v / %s", test.key, output, err, i18n.RenderError(i18n.Chinese, err))
			}
		}
	}
	service := &Service{Run: func(context.Context, string, ...string) (string, error) {
		return "", errors.New("Virtual disk “disk.img” is still mounted. Safely eject it on the target computer and try again. The current interface will keep running.")
	}}
	err := service.SelectKernel(context.Background(), "vendor", true)
	if !strings.Contains(i18n.RenderError(i18n.Chinese, err), "虚拟磁盘「disk.img」仍已挂载") {
		t.Fatal(i18n.RenderError(i18n.Chinese, err))
	}
}

func TestTailscaleJobLocaleDoesNotChangeStoredJob(t *testing.T) {
	service := &Service{Root: t.TempDir(), Events: &Events{Capacity: 10}}
	service.Run = func(context.Context, string, ...string) (string, error) {
		return "", errors.New("请确认切换控制服务器，并重新提交当前 controlURL")
	}
	if _, err := service.TailscaleAction(context.Background(), "login", "https://head.example", ""); err == nil {
		t.Fatal("expected failure")
	}
	english := *service.tailscaleJob
	chinese := *service.tailscaleJob
	LocalizeTailscaleJob(&chinese, i18n.Chinese)
	LocalizeTailscaleJob(&english, i18n.English)
	if !strings.Contains(chinese.Error, "请确认") || !strings.Contains(english.Error, "Confirm") || service.tailscaleJob.Error != english.Error {
		t.Fatalf("locale leaked: %+v %+v", english, chinese)
	}
	if events := service.Events.List(i18n.Chinese); len(events) != 1 || !strings.Contains(events[0].Text, "登录") {
		t.Fatalf("event not localized: %+v", events)
	}
}

type tailscaleTransport func(*http.Request) (*http.Response, error)

func (transport tailscaleTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return transport(r)
}

func TestTailscaleLocalStatusCacheAndPrivacy(t *testing.T) {
	calls := 0
	malformed := false
	s := &Service{Run: func(context.Context, string, ...string) (string, error) {
		t.Fatal("status spawned a process")
		return "", nil
	}}
	s.TailscaleHTTP = &http.Client{Transport: tailscaleTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		data := `{"ControlURL":"https://head.example"}`
		if strings.HasSuffix(r.URL.Path, "/status") {
			data = `{"BackendState":"Running","Version":"1.104.1","Self":{"HostName":"vim4","DNSName":"vim4.example.","TailscaleIPs":["100.64.0.1"]},"Peer":{"a":{"ID":"a","HostName":"offline","Online":false},"b":{"ID":"b","HostName":"laptop","Online":true,"TailscaleIPs":["100.64.0.2"],"CurAddr":"203.0.113.10:41641","LastSeen":"0001-01-01T00:00:00Z"}}}`
		}
		if malformed {
			data = "invalid json"
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(data)), Header: make(http.Header)}, nil
	})}
	state, err := s.Tailscale(context.Background())
	if err != nil || !state.Installed || state.ControlURL != "https://head.example" || state.Peers != 2 || state.PeersOnline != 1 || state.DNSName != "vim4.example" || state.Devices[0].HostName != "laptop" {
		t.Fatalf("state: %+v %v", state, err)
	}
	encoded, _ := json.Marshal(state)
	if strings.Contains(string(encoded), "203.0.113.10") || strings.Contains(string(encoded), "curAddr") {
		t.Fatalf("exposed endpoint: %s", encoded)
	}
	state.Devices[0].IPs[0] = "changed"
	next, err := s.Tailscale(context.Background())
	if err != nil || calls != 2 || next.Devices[0].IPs[0] != "100.64.0.2" {
		t.Fatalf("cache: %+v calls=%d err=%v", next, calls, err)
	}
	malformed = true
	s.tailscaleReadAt = time.Time{}
	if _, err := s.Tailscale(context.Background()); err == nil {
		t.Fatal("invalid LocalAPI JSON accepted")
	}
}

func TestTailscalePingIPValidation(t *testing.T) {
	s := &Service{Run: func(context.Context, string, ...string) (string, error) {
		t.Fatal("invalid IP reached helper")
		return "", nil
	}}
	for _, ip := range []string{"", "laptop.example", "192.168.1.1", "100.63.255.255", "100.128.0.0",
		"fd7a:115c:a1df::1", "fd7a:115c:a1e1::1", "::ffff:100.64.0.2", "fd7a:115c:a1e0::2%eth0",
		"100.064.0.2", "100.64.0.2/32", " 100.64.0.2", "100.64.0.2\n", "100.64.0.2;reboot", "$(reboot)", "--help"} {
		if _, err := s.TailscalePing(context.Background(), ip); err == nil {
			t.Errorf("accepted IP %q", ip)
		}
	}
	for _, ip := range []string{"100.64.0.0", "100.127.255.255", "fd7a:115c:a1e0::", "fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff"} {
		s.Run = func(ctx context.Context, name string, args ...string) (string, error) {
			if name != "sudo" || !slices.Equal(args, []string{"-n", Helper, "tailscale-ping", ip}) {
				t.Fatalf("unexpected command: %s %v", name, args)
			}
			deadline, ok := ctx.Deadline()
			if !ok || time.Until(deadline) > 30*time.Second || time.Until(deadline) < 29*time.Second {
				t.Fatal("ping has no thirty-second bound")
			}
			return `{"reachable":true,"path":"direct","via":"192.0.2.2:41641","latencyMs":[1.25,2],"lost":2,"sent":4}`, nil
		}
		result, err := s.TailscalePing(context.Background(), ip)
		if err != nil || !result.Reachable || result.Path != "direct" || result.Via != "" ||
			!slices.Equal(result.LatencyMs, []float64{1.25, 2}) || result.Lost != 2 || result.Sent != 4 {
			t.Fatalf("ping %s: %+v, %v", ip, result, err)
		}
	}
}

func TestTailscalePingConcurrencyIndependentOfJobsAndHistory(t *testing.T) {
	started, release, done := make(chan struct{}, 2), make(chan struct{}), make(chan error, 3)
	var workers sync.WaitGroup
	s := &Service{Events: &Events{Capacity: 10}, History: &History{},
		tailscaleJob: &TailscaleJob{Action: "install", Running: true},
		Run: func(context.Context, string, ...string) (string, error) {
			started <- struct{}{}
			<-release
			return `{"reachable":false,"path":"","via":"","latencyMs":[],"lost":4,"sent":4}`, nil
		}}
	defer func() { close(release); workers.Wait() }()
	// Holding both existing locks proves ping does not share either task mechanism.
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tailscaleMu.Lock()
	defer s.tailscaleMu.Unlock()
	for range 2 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			_, err := s.TailscalePing(context.Background(), "100.64.0.2")
			done <- err
		}()
	}
	for range 2 {
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("ping blocked by existing locks")
		}
	}
	if _, err := s.TailscalePing(context.Background(), "100.64.0.3"); !errors.Is(err, ErrBusy) {
		t.Fatalf("third ping: %v", err)
	}
	release <- struct{}{}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	workers.Add(1)
	go func() {
		defer workers.Done()
		_, err := s.TailscalePing(context.Background(), "100.64.0.3")
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("completed ping did not release slot")
	}
	if !s.tailscaleJob.Running || s.tailscaleJob.Action != "install" ||
		len(s.Events.List()) != 0 || len(s.History.Samples()) != 0 {
		t.Fatal("ping changed job or history")
	}
}

func TestTailscalePingErrorsReleaseSlotAndRespectCancellation(t *testing.T) {
	s := &Service{}
	for _, test := range []struct {
		output string
		err    error
	}{{"", errors.New("helper unavailable")}, {"not json", nil}, {"", context.Canceled}} {
		ctx, cancel := context.WithCancel(context.Background())
		if test.err == context.Canceled {
			cancel()
		}
		s.Run = func(ctx context.Context, _ string, _ ...string) (string, error) {
			if test.err == context.Canceled && ctx.Err() != context.Canceled {
				t.Fatal("request cancellation not propagated")
			}
			return test.output, test.err
		}
		_, err := s.TailscalePing(ctx, "100.64.0.2")
		cancel()
		if err == nil || errors.Is(err, ErrBusy) || len(s.tailscalePings) != 0 {
			t.Fatalf("error or slot leak: %v", err)
		}
	}
}

func TestTailscaleRejectsActionsAndURLsBeforeHelper(t *testing.T) {
	s := &Service{Run: func(context.Context, string, ...string) (string, error) {
		t.Fatal("invalid request reached helper")
		return "", nil
	}}
	for _, test := range []struct{ action, url string }{
		{"", ""}, {"restart", ""}, {"up", "https://head.example"},
		{"login", ""}, {"login", "ftp://head.example"}, {"login", "https://head.example/"},
		{"login", "https://user@head.example"}, {"login", "https://head.example;reboot"},
		{"login", "https://head.example\n"}, {"login", "https://head.example:123456"},
	} {
		if _, err := s.TailscaleAction(context.Background(), test.action, test.url, ""); err == nil {
			t.Errorf("accepted %+v", test)
		}
	}
}

func TestTailscaleSynchronousActionsDoNotTakeSwitchLock(t *testing.T) {
	s := &Service{Events: &Events{Capacity: 10}}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, action := range []string{"up", "down", "login", "logout"} {
		url := ""
		if action == "login" {
			url = "http://head.example:8080"
		}
		s.Run = func(ctx context.Context, name string, args ...string) (string, error) {
			want := []string{"-n", Helper, "tailscale-" + action}
			if url != "" {
				want = append(want, url)
			}
			if name != "sudo" || !slices.Equal(args, want) {
				t.Fatalf("unexpected command: %s %v", name, args)
			}
			deadline, ok := ctx.Deadline()
			if !ok || time.Until(deadline) > time.Minute {
				t.Fatal("synchronous action has no one-minute bound")
			}
			return `{"authURL":"https://head.example/register/node"}`, nil
		}
		got, err := s.TailscaleAction(context.Background(), action, url, "")
		if err != nil || (action == "login" && got != "https://head.example/register/node") {
			t.Fatalf("%s: %q, %v", action, got, err)
		}
	}
	if err := s.Select(context.Background(), "nanokvm"); !errors.Is(err, ErrBusy) {
		t.Fatalf("existing switch serialization changed: %v", err)
	}
	if events := s.Events.List(); len(events) != 4 || events[0].Text != "Sign out of Tailscale" {
		t.Fatalf("action history: %+v", events)
	}
}

func TestTailscalePackageJobSurvivesManagerRestart(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "run"), 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "run/vim4-manager-tailscale-job.json")
	run := func(_ context.Context, name string, args ...string) (string, error) {
		if name == "systemctl" {
			return "active", nil
		}
		if args[2] == "tailscale-install" {
			return "{}", os.WriteFile(path, []byte(`{"action":"install","running":true,"error":""}`), 0644)
		}
		if args[2] == "select" {
			return "", nil
		}
		t.Fatalf("unexpected command: %s %v", name, args)
		return "", nil
	}
	s := &Service{Root: root, Run: run}
	if _, err := s.TailscaleAction(context.Background(), "install", "", ""); err != nil {
		t.Fatal(err)
	}
	// The new service has no in-memory task; the worker still owns the operation.
	restarted := &Service{Root: root, Run: run}
	if _, err := restarted.TailscaleAction(context.Background(), "down", "", ""); !errors.Is(err, ErrBusy) {
		t.Fatalf("overlap after restart: %v", err)
	}
	if err := restarted.Select(context.Background(), "nanokvm"); err != nil {
		t.Fatalf("switch blocked: %v", err)
	}
	job := restarted.tailscalePackageJob(context.Background())
	if job == nil || !job.Running || job.Action != "install" {
		t.Fatalf("job: %+v", job)
	}
	if err := os.WriteFile(path, []byte(`{"action":"install","running":false,"error":"apt failed"}`), 0644); err != nil {
		t.Fatal(err)
	}
	job = restarted.tailscalePackageJob(context.Background())
	if job.Running || job.Error != "apt failed" {
		t.Fatalf("outcome: %+v", job)
	}
}

func TestTailscaleLoginFailureRecordsJobAndAllowsRetry(t *testing.T) {
	s := &Service{Events: &Events{Capacity: 10}}
	for _, output := range []string{"invalid json", `{"authURL":""}`} {
		s.Run = func(context.Context, string, ...string) (string, error) { return output, nil }
		_, err := s.TailscaleAction(context.Background(), "login", "https://head.example", "")
		if (err != nil) != (output == "invalid json") {
			t.Fatalf("output %q: %v", output, err)
		}
		if s.tailscaleJob.Running || (s.tailscaleJob.Error != "") != (err != nil) {
			t.Fatalf("job: %+v", s.tailscaleJob)
		}
	}
	s.Run = func(context.Context, string, ...string) (string, error) {
		return "", errors.New("sudo: daemon unavailable")
	}
	if _, err := s.TailscaleAction(context.Background(), "up", "", ""); err == nil || !strings.Contains(err.Error(), "daemon unavailable") {
		t.Fatalf("runner failure: %v", err)
	}
}

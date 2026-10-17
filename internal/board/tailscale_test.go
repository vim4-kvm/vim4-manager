package board

import (
	"context"
	"encoding/json"
	"errors"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestTailscaleStateAndReadErrors(t *testing.T) {
	s := &Service{Run: func(_ context.Context, name string, args ...string) (string, error) {
		if name != "sudo" || !slices.Equal(args, []string{"-n", Helper, "tailscale-status"}) {
			t.Fatalf("unexpected command: %s %v", name, args)
		}
		return `{"installed":true,"running":true,"backendState":"NeedsLogin","authURL":"https://head.example/register/1","hostName":"vim4","dnsName":"vim4.example","ips":["100.64.0.1"],"tailnet":"example","controlURL":"https://head.example","version":"1.90.1","peers":3,"peersOnline":2}`, nil
	}}
	state, err := s.Tailscale(context.Background())
	if err != nil || !state.Installed || !state.Running || state.BackendState != "NeedsLogin" ||
		state.AuthURL != "https://head.example/register/1" || state.DNSName != "vim4.example" ||
		state.ControlURL != "https://head.example" || state.Peers != 3 || state.PeersOnline != 2 ||
		!slices.Equal(state.IPs, []string{"100.64.0.1"}) || state.Devices == nil || state.Job != nil {
		t.Fatalf("state: %+v, %v", state, err)
	}
	for _, test := range []struct {
		output string
		err    error
	}{{"", errors.New("helper unavailable")}, {"not json", nil}} {
		s.Run = func(context.Context, string, ...string) (string, error) { return test.output, test.err }
		if _, err := s.Tailscale(context.Background()); err == nil {
			t.Fatal("failed read reported as valid state")
		}
	}
}

func TestTailscaleDevicesAndEmptyDefaults(t *testing.T) {
	for _, devices := range []string{"null", "[]", `[{"id":"node-id","hostName":"laptop","dnsName":"laptop.example","os":"linux","ips":["100.64.0.2"],"online":true,"lastSeen":"2026-10-16T12:34:56Z","curAddr":"192.0.2.2:41641","relay":"lax","exitNode":true,"active":true}]`} {
		s := &Service{Run: func(context.Context, string, ...string) (string, error) {
			return `{"devices":` + devices + `}`, nil
		}}
		state, err := s.Tailscale(context.Background())
		if err != nil || state.Devices == nil {
			t.Fatalf("devices %s: %+v, %v", devices, state, err)
		}
		if len(state.Devices) > 0 {
			d := state.Devices[0]
			if d.ID != "node-id" || d.HostName != "laptop" || d.DNSName != "laptop.example" || d.OS != "linux" ||
				!slices.Equal(d.IPs, []string{"100.64.0.2"}) || !d.Online || d.LastSeen != "2026-10-16T12:34:56Z" ||
				d.CurAddr != "192.0.2.2:41641" || d.Relay != "lax" || !d.ExitNode || !d.Active {
				t.Fatalf("device: %+v", d)
			}
		}
		encoded, _ := json.Marshal(state)
		if strings.Contains(string(encoded), `"devices":null`) {
			t.Fatalf("null devices: %s", encoded)
		}
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
		if err != nil || !result.Reachable || result.Path != "direct" || result.Via != "192.0.2.2:41641" ||
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
		if _, err := s.TailscaleAction(context.Background(), test.action, test.url); err == nil {
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
		got, err := s.TailscaleAction(context.Background(), action, url)
		if err != nil || (action == "login" && got != "https://head.example/register/node") {
			t.Fatalf("%s: %q, %v", action, got, err)
		}
	}
	if err := s.Select(context.Background(), "nanokvm"); !errors.Is(err, ErrBusy) {
		t.Fatalf("existing switch serialization changed: %v", err)
	}
	if events := s.Events.List(); len(events) != 4 || events[0].Text != "退出 Tailscale 登录" {
		t.Fatalf("action history: %+v", events)
	}
}

func TestTailscalePackageJobSurvivesRequestAndAllowsStatusAndSwitch(t *testing.T) {
	for _, action := range []string{"install", "uninstall"} {
		t.Run(action, func(t *testing.T) {
			started, release := make(chan context.Context, 1), make(chan struct{})
			failure := error(nil)
			if action == "uninstall" {
				failure = errors.New("apt failed")
			}
			s := &Service{Events: &Events{Capacity: 10}, Run: func(ctx context.Context, _ string, args ...string) (string, error) {
				switch args[2] {
				case "tailscale-" + action:
					started <- ctx
					<-release
					return "{}", failure
				case "tailscale-status":
					return `{"installed":false,"ips":[]}`, nil
				case "select":
					return "", nil
				default:
					return "", errors.New("unexpected command")
				}
			}}
			parent, cancel := context.WithCancel(context.Background())
			defer cancel()
			if _, err := s.TailscaleAction(parent, action, ""); err != nil {
				t.Fatal(err)
			}
			jobCtx := <-started
			cancel()
			defer close(release)
			if jobCtx.Err() != nil {
				t.Fatal("job canceled with request")
			}
			deadline, ok := jobCtx.Deadline()
			if !ok || time.Until(deadline) > 15*time.Minute || time.Until(deadline) < 14*time.Minute {
				t.Fatal("background job has wrong timeout")
			}
			for _, other := range []string{"install", "uninstall", "up", "down", "login", "logout"} {
				url := ""
				if other == "login" {
					url = "https://head.example"
				}
				if _, err := s.TailscaleAction(context.Background(), other, url); !errors.Is(err, ErrBusy) {
					t.Fatalf("concurrent %s: %v", other, err)
				}
			}
			state, err := s.Tailscale(context.Background())
			if err != nil || state.Job == nil || !state.Job.Running || state.Job.Action != action {
				t.Fatalf("in-flight status: %+v, %v", state, err)
			}
			if err := s.Select(context.Background(), "nanokvm"); err != nil {
				t.Fatalf("Tailscale job blocked KVM switch: %v", err)
			}
			// Release the runner deterministically; yield only to observe the final
			// job publication after Run returns, without timing the package command.
			release <- struct{}{}
			limit := time.After(5 * time.Second)
			for {
				state, err = s.Tailscale(context.Background())
				if err != nil {
					t.Fatal(err)
				}
				if !state.Job.Running {
					break
				}
				select {
				case <-limit:
					t.Fatal("job did not finish")
				default:
					runtime.Gosched()
				}
			}
			if (state.Job.Error != "") != (failure != nil) {
				t.Fatalf("job outcome: %+v", state.Job)
			}
			// Returned status is a snapshot, not shared mutable job state.
			state.Job.Error = "changed by caller"
			next, _ := s.Tailscale(context.Background())
			if next.Job.Error == "changed by caller" {
				t.Fatal("status exposes shared job pointer")
			}
			if events := s.Events.List(); len(events) != 2 || (events[0].Tone == "critical") != (failure != nil) {
				t.Fatalf("job history: %+v", events)
			}
		})
	}
}

func TestTailscaleLoginFailureRecordsJobAndAllowsRetry(t *testing.T) {
	s := &Service{Events: &Events{Capacity: 10}}
	for _, output := range []string{"invalid json", `{"authURL":""}`} {
		s.Run = func(context.Context, string, ...string) (string, error) { return output, nil }
		_, err := s.TailscaleAction(context.Background(), "login", "https://head.example")
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
	if _, err := s.TailscaleAction(context.Background(), "up", ""); err == nil || !strings.Contains(err.Error(), "daemon unavailable") {
		t.Fatalf("runner failure: %v", err)
	}
}

package board

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestKernelPassthroughHidesPrivilegedCommandErrors(t *testing.T) {
	provider := kernelPassthroughProvider{run: func(context.Context, string, ...string) (string, error) {
		return "", errors.New("sudo: ALSA /private/path: permission denied")
	}}
	_, err := provider.Status(context.Background())
	if err == nil || strings.Contains(err.Error(), "sudo") || strings.Contains(err.Error(), "/private") {
		t.Fatalf("raw command failure exposed: %v", err)
	}
}

func TestKernelPassthroughReportsAudioFailureWithoutLosingVideo(t *testing.T) {
	provider := kernelPassthroughProvider{run: func(context.Context, string, ...string) (string, error) {
		return `{"supported":true,"enabled":true,"audio":true,"audioState":"error","state":"running"}`, nil
	}}
	state, err := provider.Status(context.Background())
	if err != nil || !state.Audio || state.AudioState != "error" || state.State != "running" {
		t.Fatalf("audio failure affected video or saved preference: %+v %v", state, err)
	}
}

type fakePassthroughProvider struct {
	state   PassthroughState
	err     error
	calls   int
	started chan struct{}
	release chan struct{}
}

func (f *fakePassthroughProvider) Status(context.Context) (PassthroughState, error) {
	return f.state, nil
}

func (f *fakePassthroughProvider) Apply(_ context.Context, prefs PassthroughPreferences) (PassthroughState, error) {
	f.calls++
	if f.started != nil {
		close(f.started)
		<-f.release
	}
	if f.err != nil {
		return f.state, f.err
	}
	f.state.Enabled, f.state.Audio = prefs.Enabled, prefs.Audio
	f.state.HDR = prefs.HDR
	if prefs.Enabled {
		f.state.State = "running"
	} else {
		f.state.State = "off"
	}
	return f.state, nil
}

func boolPointer(value bool) *bool { return &value }

func TestPassthroughHDRMigrationAndPersistence(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "passthrough.json")
	if err := os.WriteFile(path, []byte(`{"enabled":true,"audio":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	fake := &fakePassthroughProvider{state: PassthroughState{Supported: true}}
	controller, err := OpenPassthrough(context.Background(), dir, fake, &Events{Capacity: 10})
	if err != nil || !fake.state.HDR {
		t.Fatalf("legacy preference did not default HDR on: %+v %v", fake.state, err)
	}
	actual, err := controller.Set(context.Background(), PassthroughChange{HDR: boolPointer(false)})
	if err != nil || actual.HDR || !actual.Audio || !actual.Enabled {
		t.Fatalf("HDR-only change affected other preferences: %+v %v", actual, err)
	}
	fake.state.HDR = true
	_, err = OpenPassthrough(context.Background(), dir, fake, &Events{Capacity: 10})
	if err != nil || fake.state.HDR {
		t.Fatalf("HDR false did not survive restart: %+v %v", fake.state, err)
	}
}

func TestPassthroughChangeWaitsForStatusInsteadOfReportingBusy(t *testing.T) {
	fake := &fakePassthroughProvider{state: PassthroughState{Supported: true, State: "off"}}
	controller := &Passthrough{provider: fake, path: filepath.Join(t.TempDir(), "passthrough.json"),
		events: &Events{Capacity: 10}}
	controller.mu.Lock()
	result := make(chan error, 1)
	go func() {
		_, err := controller.Set(context.Background(), PassthroughChange{Audio: boolPointer(true)})
		result <- err
	}()
	deadline := time.Now().Add(time.Second)
	for controller.changeMu.TryLock() {
		controller.changeMu.Unlock()
		if time.Now().After(deadline) {
			controller.mu.Unlock()
			t.Fatal("change did not acquire its independent writer lock")
		}
		runtime.Gosched()
	}
	_, busy := controller.Set(context.Background(), PassthroughChange{Audio: boolPointer(false)})
	controller.mu.Unlock()
	if !errors.Is(busy, ErrBusy) {
		t.Fatalf("overlapping writes were not rejected: %v", busy)
	}
	if err := <-result; err != nil {
		t.Fatalf("read-only status blocked a setting change: %v", err)
	}
	if !fake.state.Audio {
		t.Fatal("audio preference was not applied")
	}
}

func TestPassthroughPreferencesSurviveRestartAndUnsupportedKernel(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	events := &Events{Capacity: 60}
	fake := &fakePassthroughProvider{state: PassthroughState{Supported: true, State: "off"}}
	p, err := OpenPassthrough(ctx, dir, fake, events)
	if err != nil {
		t.Fatal(err)
	}
	// Audio can be saved while video is off; a later enabled-only patch must
	// preserve that preference and restart must restore both fields.
	state, err := p.Set(ctx, PassthroughChange{Audio: boolPointer(true)})
	if err != nil || state.Enabled || !state.Audio {
		t.Fatalf("save audio: %+v %v", state, err)
	}
	state, err = p.Set(ctx, PassthroughChange{Enabled: boolPointer(true)})
	if err != nil || !state.Enabled || !state.Audio {
		t.Fatalf("enable: %+v %v", state, err)
	}
	path := filepath.Join(dir, "passthrough.json")
	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	unsupported, err := OpenPassthrough(ctx, dir, &fakePassthroughProvider{state: PassthroughState{State: "unsupported"}}, events)
	if err != nil {
		t.Fatal(err)
	}
	state, err = unsupported.Status(ctx)
	if err != nil || state.Supported || state.Enabled || state.State != "unsupported" {
		t.Fatalf("unsupported: %+v %v", state, err)
	}
	_, err = unsupported.Set(ctx, PassthroughChange{Enabled: boolPointer(true)})
	if !errors.Is(err, ErrPassthroughUnsupported) {
		t.Fatalf("unsupported write: %v", err)
	}
	after, _ := os.ReadFile(path)
	if string(after) != string(saved) {
		t.Fatal("unsupported kernel changed saved preferences")
	}
	fresh := &fakePassthroughProvider{state: PassthroughState{Supported: true, State: "off"}}
	restarted, err := OpenPassthrough(ctx, dir, fresh, events)
	if err != nil {
		t.Fatal(err)
	}
	state, err = restarted.Status(ctx)
	if err != nil || !state.Enabled || !state.Audio || fresh.calls != 1 {
		t.Fatalf("restart: %+v calls=%d %v", state, fresh.calls, err)
	}
	_, err = restarted.Set(ctx, PassthroughChange{Enabled: boolPointer(false)})
	if err != nil {
		t.Fatal(err)
	}
	texts := []string{}
	for _, event := range events.List() {
		texts = append(texts, event.Text)
	}
	for _, want := range []string{"透传已开启", "透传已关闭", "透传失败：当前内核不支持"} {
		if !strings.Contains(strings.Join(texts, "\n"), want) {
			t.Fatalf("missing %q in %v", want, texts)
		}
	}
}

func TestPassthroughFailureDoesNotPersistAndSaveFailureRestoresKernel(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	fake := &fakePassthroughProvider{state: PassthroughState{Supported: true, State: "off"}, err: errors.New("kernel refused")}
	events := &Events{Capacity: 60}
	p, err := OpenPassthrough(ctx, dir, fake, events)
	if err != nil {
		t.Fatal(err)
	}
	state, err := p.Set(ctx, PassthroughChange{Enabled: boolPointer(true)})
	if err == nil || state.Enabled {
		t.Fatalf("failed apply: %+v %v", state, err)
	}
	if _, err := os.Stat(p.path); !os.IsNotExist(err) {
		t.Fatalf("failed apply wrote preferences: %v", err)
	}
	if got := events.List()[0].Text; got != "透传失败：kernel refused" {
		t.Fatal(got)
	}
	fake.err = nil
	// A directory at the destination deterministically fails the atomic
	// rename, even when tests run as root.
	if err := os.Mkdir(p.path, 0700); err != nil {
		t.Fatal(err)
	}
	state, err = p.Set(ctx, PassthroughChange{Enabled: boolPointer(true)})
	if err == nil || !strings.Contains(err.Error(), "保存透传设置失败") || state.Enabled || fake.state.Enabled {
		t.Fatalf("failed save must restore: %+v %v", state, err)
	}
}

func TestPassthroughScalingEventsFollowChanges(t *testing.T) {
	fake := &fakePassthroughProvider{state: PassthroughState{Supported: true, Enabled: true, State: "running",
		Output: &PassthroughOutput{Width: 1920, Height: 1080, RefreshHz: 59.94, Scaled: true}}}
	events := &Events{Capacity: 60}
	p, err := OpenPassthrough(context.Background(), t.TempDir(), fake, events)
	if err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if _, err := p.Status(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if got := events.List(); len(got) != 1 || got[0].Text != "透传输出已缩放到 1920×1080 59.94Hz" {
		t.Fatalf("scale event duplicated or incorrect: %v", got)
	}
	fake.state.Output = &PassthroughOutput{Width: 1280, Height: 720, RefreshHz: 23.976, Scaled: true}
	_, _ = p.Status(context.Background())
	if got := events.List(); len(got) != 2 || got[0].Text != "透传输出已缩放到 1280×720 23.98Hz" {
		t.Fatalf("changed scale: %v", got)
	}
}

func TestPassthroughRejectsCorruptPreferences(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "passthrough.json"), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenPassthrough(context.Background(), dir, nil, nil); err == nil {
		t.Fatal("silently ignored corrupt preferences")
	}
}

func TestPassthroughPartialChangePreservesActualSettings(t *testing.T) {
	fake := &fakePassthroughProvider{state: PassthroughState{Supported: true, Enabled: true, Audio: true, State: "running"}}
	p, err := OpenPassthrough(context.Background(), t.TempDir(), fake, nil)
	if err != nil {
		t.Fatal(err)
	}
	state, err := p.Set(context.Background(), PassthroughChange{Audio: boolPointer(false)})
	if err != nil || !state.Enabled || state.Audio {
		t.Fatalf("audio-only change stopped video: %+v %v", state, err)
	}
}

func TestPassthroughConcurrentWritesAreRejected(t *testing.T) {
	fake := &fakePassthroughProvider{state: PassthroughState{Supported: true, State: "off"}, started: make(chan struct{}), release: make(chan struct{})}
	p, err := OpenPassthrough(context.Background(), t.TempDir(), fake, nil)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := p.Set(context.Background(), PassthroughChange{Enabled: boolPointer(true)})
		done <- err
	}()
	<-fake.started
	_, concurrentErr := p.Set(context.Background(), PassthroughChange{Enabled: boolPointer(false)})
	close(fake.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if !errors.Is(concurrentErr, ErrBusy) || !fake.state.Enabled || fake.calls != 1 {
		t.Fatalf("concurrent change reached provider: %+v %v", fake, concurrentErr)
	}
}

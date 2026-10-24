package board

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakePassthroughProvider struct {
	state PassthroughState
	err   error
	calls int
}

func (f *fakePassthroughProvider) Status(context.Context) (PassthroughState, error) {
	return f.state, nil
}

func (f *fakePassthroughProvider) Apply(_ context.Context, prefs PassthroughPreferences) (PassthroughState, error) {
	f.calls++
	if f.err != nil {
		return f.state, f.err
	}
	f.state.Enabled, f.state.Audio = prefs.Enabled, prefs.Audio
	if prefs.Enabled {
		f.state.State = "running"
	} else {
		f.state.State = "off"
	}
	return f.state, nil
}

func boolPointer(value bool) *bool { return &value }

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
	unsupported, err := OpenPassthrough(ctx, dir, nil, events)
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

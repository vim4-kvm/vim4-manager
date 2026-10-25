package board

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestKernelPassthroughUnsupportedPreservesHardware(t *testing.T) {
	calls := 0
	provider := kernelPassthroughProvider{run: func(ctx context.Context, name string, args ...string) (string, error) {
		calls++
		if name != "sudo" || !reflect.DeepEqual(args, []string{"-n", Helper, "passthrough-status"}) {
			t.Fatalf("unexpected command: %s %v", name, args)
		}
		return `{"supported":false,"enabled":false,"state":"unsupported"}`, nil
	}}
	state, err := provider.Apply(context.Background(), PassthroughPreferences{Enabled: true})
	if !errors.Is(err, ErrPassthroughUnsupported) || state.Supported || calls != 1 {
		t.Fatalf("unsupported apply: %+v %v calls=%d", state, err, calls)
	}
}

func TestKernelPassthroughFailedApplyReturnsActualState(t *testing.T) {
	calls := 0
	provider := kernelPassthroughProvider{run: func(ctx context.Context, name string, args ...string) (string, error) {
		calls++
		switch calls {
		case 1:
			return `{"supported":true,"enabled":true,"state":"running"}`, nil
		case 2:
			if !reflect.DeepEqual(args, []string{"-n", Helper, "passthrough-set", "false", "false", "false"}) {
				t.Fatalf("unexpected set: %v", args)
			}
			return "", errors.New("modeset failed")
		default:
			return `{"supported":true,"enabled":false,"state":"off"}`, nil
		}
	}}
	state, err := provider.Apply(context.Background(), PassthroughPreferences{})
	if err == nil || state.Enabled || state.State != "off" || calls != 3 {
		t.Fatalf("failed apply: %+v %v calls=%d", state, err, calls)
	}
}

func TestKernelPassthroughRejectsInvalidHelperReply(t *testing.T) {
	for _, reply := range []string{"not json", "{}"} {
		provider := kernelPassthroughProvider{run: func(context.Context, string, ...string) (string, error) {
			return reply, nil
		}}
		if _, err := provider.Status(context.Background()); err == nil {
			t.Fatalf("accepted invalid reply: %q", reply)
		}
	}
}

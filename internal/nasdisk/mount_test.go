package nasdisk

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestMountCancellationReleasesWaiterAndCleansLateMount(t *testing.T) {
	for _, timeout := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancel", true: "deadline"}[timeout], func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			if timeout {
				ctx, cancel = context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
			}
			defer cancel()
			entered, release, cleaned := make(chan struct{}), make(chan struct{}), make(chan struct{}, 2)
			done := make(chan error, 1)
			go func() {
				_, err := waitForMount(ctx, func() (func() error, error) { close(entered); <-release; return func() error { return nil }, nil }, func() error { cleaned <- struct{}{}; return nil })
				done <- err
			}()
			<-entered
			cancel()
			select {
			case err := <-done:
				if timeout && (err == nil || !strings.Contains(err.Error(), "FUSE 无响应")) {
					t.Fatalf("error %v", err)
				}
				if !timeout && !errors.Is(err, context.Canceled) {
					t.Fatalf("error %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("mount cancellation blocked")
			}
			<-cleaned
			close(release)
			select {
			case <-cleaned:
			case <-time.After(time.Second):
				t.Fatal("late mount not cleaned")
			}
		})
	}
}

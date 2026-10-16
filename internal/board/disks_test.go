package board

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestUploadDoesNotHoldSwitchMutex(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	s := &Service{
		Run: func(_ context.Context, _ string, args ...string) (string, error) {
			return `[]`, nil
		},
		Stream: func(ctx context.Context, input io.Reader, output io.Writer, name string, args ...string) error {
			if args[2] == "disk-list" {
				_, err := io.WriteString(output, "[]")
				return err
			}
			if name != "sudo" || strings.Join(args, " ") != "-n "+Helper+" disk-put disk.img /file 4 0" {
				t.Errorf("unexpected invocation: %s %v", name, args)
			}
			close(started)
			<-release
			_, err := io.Copy(output, input)
			return err
		},
	}
	done := make(chan error, 1)
	go func() {
		done <- s.UploadDiskFile(context.Background(), "disk.img", "/file", 4, false, strings.NewReader("data"))
	}()
	<-started
	if _, err := s.DiskCommand(context.Background(), "disk-list"); err != nil {
		t.Error(err)
	}
	if err := s.Select(context.Background(), "jetkvm"); err != nil {
		t.Error(err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestDiskCommandBypassesBusyGateAndRejectsInvalidJSON(t *testing.T) {
	s := &Service{Stream: func(_ context.Context, _ io.Reader, out io.Writer, _ string, _ ...string) error {
		_, err := io.WriteString(out, "bad")
		return err
	}}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.DiskCommand(context.Background(), "disk-list"); err == nil || errors.Is(err, ErrBusy) {
		t.Fatalf("expected invalid response, got %v", err)
	}
}

type readyWriter struct{ ready chan struct{} }

func (w readyWriter) Write(p []byte) (int, error) { close(w.ready); return len(p), nil }

func TestExecStreamCancellation(t *testing.T) {
	// A readiness byte makes cancellation deterministic, without waiting for a timer.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- ExecStream(ctx, nil, readyWriter{ready}, "sh", "-c", "printf x; exec sleep 60") }()
	select {
	case <-ready:
	case err := <-done:
		t.Fatalf("process exited before readiness: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("process did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled process did not exit")
	}
}

func TestExecStreamCopiesBinaryAndBoundsErrors(t *testing.T) {
	var out bytes.Buffer
	data := []byte{0, 255, 1, 2}
	if err := ExecStream(context.Background(), bytes.NewReader(data), &out, "cat"); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, out.Bytes()) {
		t.Fatal("binary stream changed")
	}
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip(err)
	}
	err = ExecStream(context.Background(), nil, io.Discard, python, "-c", "import sys; sys.stderr.write('x'*100000); sys.exit(1)")
	if err == nil || len(err.Error()) != 16384 {
		t.Fatal("stderr was not bounded to 16 KiB")
	}
}

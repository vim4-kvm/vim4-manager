package nasdisk

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/vfat"
)

type sourceFunc func(vfat.SourceID, []byte, int64) (int, error)

func (f sourceFunc) ReadAt(id vfat.SourceID, p []byte, off int64) (int, error) {
	return f(id, p, off)
}

type readerFunc func([]byte, int64) (int, error)

func (f readerFunc) ReadAt(p []byte, off int64) (int, error) { return f(p, off) }

func requireIOError(t *testing.T, operation func() (int, error)) {
	t.Helper()
	started := time.Now()
	if n, err := operation(); n != 0 || !errors.Is(err, syscall.EIO) {
		t.Fatalf("expected EIO with no published bytes, got %d, %v", n, err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("I/O exceeded test deadline: %s", elapsed)
	}
}

func TestDiskSourceTimeoutRecoversWithoutInvalidatingSnapshot(t *testing.T) {
	s := testSession(t)
	entered, release, completed := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var first atomic.Bool
	source := sourceFunc(func(id vfat.SourceID, p []byte, off int64) (int, error) {
		if first.CompareAndSwap(false, true) {
			close(entered)
			<-release
			defer close(completed)
		}
		return s.source.ReadAt(id, p, off)
	})
	disk := &Disk{Reader: vfat.NewVolume(s.layout, source), ioTimeout: 40 * time.Millisecond}
	off := s.layout.Geometry.ClusterOffset(s.layout.Entries[1].FirstCluster)
	buffer := []byte("untouched")
	result := make(chan error, 1)
	go func() { _, err := disk.ReadAt(buffer, off); result <- err }()
	<-entered
	if err := <-result; !errors.Is(err, syscall.EIO) {
		t.Fatalf("source timeout: %v", err)
	}
	if string(buffer) != "untouched" || !disk.NasStalled(time.Now()) {
		t.Fatalf("timeout published data or omitted stall: %q", buffer)
	}
	// Another request can succeed while the first syscall is still blocked.
	good := make([]byte, 8)
	if _, err := disk.ReadAt(good, off); err != nil || string(good) != "original" {
		t.Fatalf("timeout poisoned later source reads: %q, %v", good, err)
	}
	copy(buffer, "reused!!!")
	close(release)
	<-completed
	if string(buffer) != "reused!!!" {
		t.Fatalf("late read modified a reused caller buffer: %q", buffer)
	}
	last := time.Unix(0, disk.lastTimeout.Load())
	if !disk.NasStalled(last.Add(9*time.Second)) || disk.NasStalled(last.Add(10*time.Second)) {
		t.Fatal("stall indication did not expire after ten seconds")
	}
	if _, err := disk.ReadAt(good, off); err != nil {
		t.Fatalf("recovered source permanently rejected: %v", err)
	}
}

func TestDiskCapsBlockedBackgroundOperations(t *testing.T) {
	entered := make(chan struct{}, maxBackgroundIO+1)
	release := make(chan struct{})
	var workers sync.WaitGroup
	workers.Add(maxBackgroundIO)
	disk := &Disk{ioTimeout: 40 * time.Millisecond, Reader: readerFunc(func(p []byte, off int64) (int, error) {
		defer workers.Done()
		entered <- struct{}{}
		<-release
		return len(p), nil
	})}
	results := make(chan error, maxBackgroundIO)
	for i := 0; i < maxBackgroundIO; i++ {
		go func() { _, err := disk.ReadAt(make([]byte, 4096), 0); results <- err }()
		<-entered
	}
	for i := 0; i < maxBackgroundIO; i++ {
		if err := <-results; !errors.Is(err, syscall.EIO) {
			t.Fatalf("blocked read: %v", err)
		}
	}
	for i := 0; i < 32; i++ {
		requireIOError(t, func() (int, error) { return disk.ReadAt(make([]byte, 4096), 0) })
	}
	if len(entered) != 0 {
		t.Fatal("excess requests started more backend operations")
	}
	close(release)
	workers.Wait()
}

type blockedOverlay struct {
	vfat.Overlay
	entered chan struct{}
	release chan struct{}
	calls   atomic.Int32
}

func (o *blockedOverlay) WriteAt(p []byte, off int64) (int, error) {
	if o.calls.Add(1) == 1 {
		close(o.entered)
		<-o.release
	}
	return o.Overlay.WriteAt(p, off)
}

func TestDiskWriteTimeoutPreservesOrderAndRequiresDecision(t *testing.T) {
	s := testSession(t)
	backend := &blockedOverlay{Overlay: s.disk.Overlay, entered: make(chan struct{}), release: make(chan struct{})}
	s.disk = &Disk{Reader: backend, Overlay: backend, ioTimeout: 40 * time.Millisecond}
	s.disk.EnableWrites()
	off := s.layout.Geometry.ClusterOffset(s.layout.Entries[1].FirstCluster)
	payload := []byte("late old")
	result := make(chan error, 1)
	go func() { _, err := s.disk.WriteAt(payload, off); result <- err }()
	<-backend.entered
	if err := <-result; !errors.Is(err, syscall.EIO) {
		t.Fatalf("write timeout: %v", err)
	}
	copy(payload, "recycled")
	requireIOError(t, func() (int, error) { return s.disk.WriteAt([]byte("expired!"), off) })
	requireIOError(t, func() (int, error) { return s.disk.ReadAt(make([]byte, 8), off) })
	if backend.calls.Load() != 1 || s.disk.Written() != 0 {
		t.Fatal("an expired waiter reached the overlay, or status waited for I/O")
	}
	s.runtimeDir = t.TempDir()
	publishOnce := func() Status {
		t.Helper()
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		done := make(chan struct{})
		go func() { s.publish(ctx); close(done) }()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("status publication blocked on the overlay")
		}
		data, err := os.ReadFile(s.runtimePath("status.json"))
		if err != nil {
			t.Fatal(err)
		}
		var status Status
		if err := json.Unmarshal(data, &status); err != nil {
			t.Fatal(err)
		}
		return status
	}
	if status := publishOnce(); !status.NasStalled {
		t.Fatal("session omitted nasStalled during blocked write")
	}
	// Eject while the syscall is blocked must preserve the layer for a decision.
	if err := s.commit(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if s.state() != "needs-decision" || s.status.Decision.Reason != "NAS 在 U 盘写入期间暂时无响应" || s.journal != nil {
		t.Fatalf("blocked eject: %+v", s.status)
	}
	close(backend.release)
	if err := s.disk.Freeze(); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 8)
	if _, err := s.disk.ReadAt(got, off); err != nil || string(got) != "late old" {
		t.Fatalf("write used a recycled buffer: %q %v", got, err)
	}
	s.disk.EnableWrites()
	if _, err := s.disk.WriteAt([]byte("new last"), off); err != nil {
		t.Fatal(err)
	}
	if _, err := s.disk.ReadAt(got, off); err != nil || string(got) != "new last" || backend.calls.Load() != 2 {
		t.Fatalf("late or expired write overwrote newer data: %q %v", got, err)
	}
	s.disk.lastTimeout.Store(time.Now().Add(-nasStallWindow).UnixNano())
	if status := publishOnce(); status.NasStalled || status.WrittenBytes == 0 {
		t.Fatalf("recovered status retained stall or lost progress: %+v", status)
	}
	if err := s.commit(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if s.state() != "needs-decision" || !s.status.Decision.CanForce || s.journal != nil {
		t.Fatalf("valid FAT bypassed the timeout decision: %+v", s.status)
	}
	if err := s.commit(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if s.journal == nil {
		t.Fatal("explicit recovery did not commit")
	}
}

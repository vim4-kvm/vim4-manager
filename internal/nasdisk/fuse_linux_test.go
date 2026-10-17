//go:build linux

package nasdisk

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/vfat"
)

type stalledReader struct{ entered chan struct{} }

func TestFUSEIOTimeoutReturnsEIOAndRecovers(t *testing.T) {
	if _, err := os.Stat("/dev/fuse"); err != nil {
		t.Skip("/dev/fuse unavailable")
	}
	for _, mode := range []string{"read", "write"} {
		t.Run(mode, func(t *testing.T) {
			s := testSession(t)
			release := make(chan struct{})
			defer func() {
				select {
				case <-release:
				default:
					close(release)
				}
			}()
			// Exercise the production deadline through actual kernel I/O.
			disk := &Disk{Size: s.layout.Geometry.Size}
			if mode == "read" {
				volume := vfat.NewVolume(s.layout, s.source)
				var first atomic.Bool
				disk.Reader = readerFunc(func(p []byte, off int64) (int, error) {
					if first.CompareAndSwap(false, true) {
						<-release
					}
					return volume.ReadAt(p, off)
				})
			} else {
				backend := &blockedOverlay{Overlay: s.disk.Overlay, entered: make(chan struct{}), release: release}
				disk.Reader, disk.Overlay = backend, backend
				disk.EnableWrites()
			}
			mount := t.TempDir()
			unmount, err := MountDisk(context.Background(), mount, "disk.img", disk)
			if err != nil {
				t.Fatal(err)
			}
			defer unmount()
			flags := os.O_RDONLY
			if mode == "write" {
				flags = os.O_RDWR
			}
			file, err := os.OpenFile(filepath.Join(mount, "disk.img"), flags, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			off := s.layout.Geometry.ClusterOffset(s.layout.Entries[1].FirstCluster)
			buffer := make([]byte, 8)
			operation := func() (int, error) { return file.ReadAt(buffer, off) }
			if mode == "write" {
				operation = func() (int, error) { return file.WriteAt([]byte("host new"), off) }
			}
			started := time.Now()
			if n, err := operation(); n != 0 || !errors.Is(err, syscall.EIO) {
				t.Fatalf("FUSE timeout: %d %v", n, err)
			}
			elapsed := time.Since(started)
			budget := disk.ioTimeout
			if budget == 0 {
				budget = diskIOTimeout
			}
			if elapsed > budget+time.Second || elapsed < budget-50*time.Millisecond {
				t.Fatalf("FUSE deadline: %s (budget %s)", elapsed, budget)
			}
			t.Logf("FUSE %s returned EIO after %s", mode, elapsed)
			if !disk.NasStalled(time.Now()) {
				t.Fatal("FUSE timeout omitted stall status")
			}
			if mode == "write" {
				disk.ioTimeout = 100 * time.Millisecond
				requireIOError(t, operation)
				if err := file.Sync(); !errors.Is(err, syscall.EIO) {
					t.Fatalf("FUSE fsync exceeded the I/O bound: %v", err)
				}
			}
			close(release)
			if err := disk.Sync(); err != nil {
				t.Fatal(err)
			}
			want := "original"
			if mode == "write" {
				want = "host new"
			}
			if _, err := file.ReadAt(buffer, off); err != nil || string(buffer) != want {
				t.Fatalf("FUSE recovery: %q %v", buffer, err)
			}
		})
	}
}

func (r stalledReader) ReadAt(p []byte, off int64) (int, error) {
	close(r.entered)
	select {} // Simulate a serving callback that never completes.
}

// Run in a child so a deliberately blocked server callback cannot leak into
// other tests. The kernel reader must be released before the daemon exits.
func TestFUSEStopAbortsBlockedIO(t *testing.T) {
	if mount := os.Getenv("NASDISK_STOP_TEST_MOUNT"); mount != "" {
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM)
		defer cancel()
		entered := make(chan struct{})
		disk := &Disk{Reader: stalledReader{entered}, Size: 4096, Released: make(chan struct{}, 1)}
		unmount, err := MountDisk(ctx, mount, "disk.img", disk)
		if err != nil {
			t.Fatal(err)
		}
		readDone := make(chan error, 1)
		go func() { _, err := os.ReadFile(filepath.Join(mount, "disk.img")); readDone <- err }()
		<-entered
		fmt.Println("READY")
		<-ctx.Done()
		if err := unmount(); err != nil {
			t.Fatal(err)
		}
		select {
		case err := <-readDone:
			if err == nil {
				t.Fatal("blocked read unexpectedly succeeded")
			}
		case <-time.After(time.Second):
			t.Fatal("kernel reader still blocked after abort")
		}
		return
	}
	if _, err := os.Stat("/dev/fuse"); err != nil {
		t.Skip("/dev/fuse unavailable")
	}
	if os.Geteuid() != 0 {
		t.Skip("connection abort requires root")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	mount := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, executable, "-test.run=^TestFUSEStopAbortsBlockedIO$", "-test.v")
	child.Env = append(os.Environ(), "NASDISK_STOP_TEST_MOUNT="+mount)
	output, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	child.Stderr = os.Stderr
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	defer child.Process.Kill()
	scanner := bufio.NewScanner(output)
	ready := false
	for scanner.Scan() {
		if scanner.Text() == "READY" {
			ready = true
			break
		}
	}
	if !ready {
		t.Fatalf("child never blocked in FUSE: %v", child.Wait())
	}
	if err = child.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	// Drain stdout so the test harness can finish without a full pipe.
	for scanner.Scan() {
	}
	if err = child.Wait(); err != nil {
		t.Fatalf("SIGTERM cleanup: %v (deadline %v)", err, ctx.Err())
	}
}

func TestFUSEWriteback(t *testing.T) {
	if _, err := os.Stat("/dev/fuse"); err != nil {
		t.Skip("/dev/fuse unavailable")
	}
	for _, tool := range []string{"fsck.fat", "mcopy", "mdel", "mmd"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(tool + " unavailable")
		}
	}
	root := t.TempDir()
	mount := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "old.txt"), []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	source, err := OpenSource(root, vfat.Tree{})
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	tree, err := source.Scan(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	layout, err := vfat.Build(tree, vfat.Options{Label: "TEST", WritableBytes: 256 << 20})
	if err != nil {
		t.Fatal(err)
	}
	session := filepath.Join(root, PrivateName, "test")
	if err = os.MkdirAll(session, 0700); err != nil {
		t.Fatal(err)
	}
	overlay, err := vfat.OpenFileOverlay(vfat.NewVolume(layout, source), filepath.Join(session, "overlay"))
	if err != nil {
		t.Fatal(err)
	}
	defer overlay.Close()
	disk := &Disk{Reader: overlay, Overlay: overlay, Size: layout.Geometry.Size, Released: make(chan struct{}, 1)}
	disk.EnableWrites()
	unmount, err := MountDisk(context.Background(), mount, "disk.img", disk)
	if err != nil {
		t.Fatal(err)
	}
	defer unmount()
	image := filepath.Join(mount, "disk.img")
	run := func(tool string, args ...string) {
		t.Helper()
		output, err := exec.Command(tool, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("%s: %v\n%s", tool, err, output)
		}
	}
	run("fsck.fat", "-n", image)
	payload := filepath.Join(t.TempDir(), "payload")
	if err = os.WriteFile(payload, []byte("host contents"), 0600); err != nil {
		t.Fatal(err)
	}
	run("mmd", "-i", image, "::/folder")
	run("mcopy", "-i", image, payload, "::/folder/new.txt")
	run("mdel", "-i", image, "::/old.txt")
	run("fsck.fat", "-n", image)
	if err = disk.Freeze(); err != nil {
		t.Fatal(err)
	}
	result, err := vfat.Parse(context.Background(), overlay, vfat.ReaderOptions{})
	if err != nil {
		t.Fatal(err)
	}
	plan, err := vfat.BuildPlan(tree, layout, result, overlay.DirtyClusters(), vfat.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	journal, err := Prepare(context.Background(), root, session, "test", plan, result)
	if err != nil {
		t.Fatal(err)
	}
	if err = journal.Execute(context.Background(), root, session, nil); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "folder/new.txt"))
	if err != nil || string(data) != "host contents" {
		t.Fatalf("%q %v", data, err)
	}
	data, err = os.ReadFile(filepath.Join(root, PrivateName, "trash/test/old.txt"))
	if err != nil || string(data) != "original" {
		t.Fatalf("trash %q %v", data, err)
	}
	if _, err = os.Stat(filepath.Join(root, "old.txt")); !os.IsNotExist(err) {
		t.Fatalf("old file retained: %v", err)
	}
}

package nasdisk

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"testing/synctest"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/vfat"
)

func TestSourceSnapshotAndMutation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		testSourceSnapshotAndMutation(t)
	})
}

func testSourceSnapshotAndMutation(t *testing.T) {
	root := canonicalTemp(t)
	file := filepath.Join(root, "data")
	if err := os.WriteFile(file, []byte("before"), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := OpenSource(root, vfat.Tree{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	tree, err := s.Scan(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 6)
	if n, err := s.ReadAt(tree.Children[0].SourceID, buf, 0); err != nil || n != 6 || string(buf) != "before" {
		t.Fatalf("read %q %d %v", buf, n, err)
	}
	changed := tree.Children[0].Mtime.Add(time.Second)
	if err := os.Chtimes(file, changed, changed); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadAt("data", buf, 0); !errors.Is(err, syscall.EIO) {
		t.Fatalf("modified source: %v", err)
	}
	time.Sleep(1100 * time.Millisecond)
	synctest.Wait()
	// A changed source stays invalid even if metadata is subsequently restored.
	if err := os.Chtimes(file, tree.Children[0].Mtime, tree.Children[0].Mtime); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadAt("data", buf, 0); !errors.Is(err, syscall.EIO) {
		t.Fatal(err)
	}
}

func TestSourceTransientMismatchDoesNotBlockOtherFiles(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := testSession(t)
		file := s.layout.Entries[1]
		other := s.layout.Entries[2]
		changed := file.Node.Mtime.Add(time.Second)
		name := filepath.Join(s.status.Root, "file")
		if err := os.Chtimes(name, changed, changed); err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, 8)
		if _, err := s.disk.ReadAt(buf, s.layout.Geometry.ClusterOffset(file.FirstCluster)); !errors.Is(err, syscall.EIO) {
			t.Fatalf("transient mismatch: %v", err)
		}
		synctest.Wait()
		if _, err := s.disk.ReadAt(buf, s.layout.Geometry.ClusterOffset(other.FirstCluster)); err != nil || string(buf) != "original" {
			t.Fatalf("other file blocked or corrupted: %q %v", buf, err)
		}
		if _, err := s.source.ReadAt("file", buf, 0); !errors.Is(err, syscall.EIO) {
			t.Fatalf("pending recheck accepted a read: %v", err)
		}
		if err := os.Chtimes(name, file.Node.Mtime, file.Node.Mtime); err != nil {
			t.Fatal(err)
		}
		time.Sleep(1100 * time.Millisecond)
		synctest.Wait()
		if _, err := s.disk.ReadAt(buf, s.layout.Geometry.ClusterOffset(file.FirstCluster)); err != nil || string(buf) != "original" {
			t.Fatalf("rechecked source not recovered: %q %v", buf, err)
		}
	})
}

func TestSourceRecheckOpenFailureRemainsRetryable(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := testSession(t)
		node := s.layout.Entries[1].Node
		name := filepath.Join(s.status.Root, "file")
		changed := node.Mtime.Add(time.Second)
		if err := os.Chtimes(name, changed, changed); err != nil {
			t.Fatal(err)
		}
		if _, err := s.source.ReadAt("file", make([]byte, 8), 0); !errors.Is(err, syscall.EIO) {
			t.Fatal(err)
		}
		if err := os.Remove(name); err != nil {
			t.Fatal(err)
		}
		time.Sleep(1100 * time.Millisecond)
		synctest.Wait()
		if _, err := s.source.ReadAt("file", make([]byte, 8), 0); !errors.Is(err, syscall.EIO) {
			t.Fatal(err)
		}
		if err := os.WriteFile(name, []byte("original"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(name, node.Mtime, node.Mtime); err != nil {
			t.Fatal(err)
		}
		if _, err := s.source.ReadAt("file", make([]byte, 8), 0); err != nil {
			t.Fatalf("temporary open failure permanently invalidated source: %v", err)
		}
	})
}

func TestSourceRenameReplacementImmediatelyScanned(t *testing.T) {
	root := canonicalTemp(t)
	mtime := time.Unix(1792253790, 0)
	for range 16 {
		file, err := os.CreateTemp(root, "replacement-")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = file.Write([]byte("replacement")); err != nil {
			t.Fatal(err)
		}
		if err = file.Sync(); err != nil {
			t.Fatal(err)
		}
		if err = file.Close(); err != nil {
			t.Fatal(err)
		}
		name := filepath.Join(root, "random.bin")
		if err = os.Rename(file.Name(), name); err != nil {
			t.Fatal(err)
		}
		if err = os.Chtimes(name, mtime, mtime); err != nil {
			t.Fatal(err)
		}
		source, err := OpenSource(root, vfat.Tree{})
		if err != nil {
			t.Fatal(err)
		}
		_, err = source.Scan(context.Background(), nil)
		if err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, 11)
		_, err = source.ReadAt("random.bin", buf, 0)
		source.Close()
		if err != nil || string(buf) != "replacement" {
			t.Fatalf("read after rename/utimens/scan: %q %v", buf, err)
		}
	}
}

func TestSourceRejectsReplacedParentAndExcludesPrivateDirectory(t *testing.T) {
	root := canonicalTemp(t)
	if err := os.Mkdir(filepath.Join(root, "folder"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "folder/file"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, PrivateName), 0700); err != nil {
		t.Fatal(err)
	}
	s, err := OpenSource(root, vfat.Tree{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	tree, err := s.Scan(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(tree.Children) != 1 {
		t.Fatalf("private directory included: %+v", tree)
	}
	if err := os.Rename(filepath.Join(root, "folder"), filepath.Join(root, "moved")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("moved", filepath.Join(root, "folder")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadAt("folder/file", make([]byte, 4), 0); !errors.Is(err, syscall.EIO) {
		t.Fatalf("symlink followed: %v", err)
	}
}

func canonicalTemp(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func TestWritableReserve(t *testing.T) {
	for _, test := range []struct {
		free, want int64
		reject     bool
	}{
		{0, 0, true}, {(2 << 30) + (256 << 20) - 1, 0, true}, {(2 << 30) + (256 << 20), 256 << 20, false}, {100 << 30, 64 << 30, false},
	} {
		got, err := WritableReserve(test.free)
		if (err != nil) != test.reject || got != test.want {
			t.Fatalf("%d: %d %v", test.free, got, err)
		}
	}
}

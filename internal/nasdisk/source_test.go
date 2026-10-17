package nasdisk

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/vfat"
)

func TestSourceSnapshotAndMutation(t *testing.T) {
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
	// A changed source stays invalid even if metadata is subsequently restored.
	if err := os.Chtimes(file, tree.Children[0].Mtime, tree.Children[0].Mtime); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadAt("data", buf, 0); !errors.Is(err, syscall.EIO) {
		t.Fatal(err)
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

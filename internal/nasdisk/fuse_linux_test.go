//go:build linux

package nasdisk

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/vim4-kvm/vim4-manager/internal/vfat"
)

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
	unmount, err := MountDisk(mount, "disk.img", disk)
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

package vfat

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func requireTools(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Skip("real FAT tools require Linux")
	}
	for _, name := range []string{"fsck.fat", "mkfs.fat", "mdir", "mtype", "mcopy", "mren", "mmove", "mdel", "mmd", "mrd"} {
		if _, err := exec.LookPath(name); err != nil {
			t.Skipf("missing %s", name)
		}
	}
}
func command(t *testing.T, name string, args ...string) []byte {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Env = append(os.Environ(), "TZ=UTC", "LC_ALL=C.UTF-8")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %q: %v\n%s", name, args, err, out)
	}
	return out
}
func materialize(t *testing.T, v *Volume) string {
	t.Helper()
	name := filepath.Join(t.TempDir(), "disk.img")
	f, err := os.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(f, io.NewSectionReader(v, 0, v.Layout.Geometry.Size)); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return name
}

func TestRealToolsRoundTripAndEdits(t *testing.T) {
	requireTools(t)
	tree, l, v := fixture(t)
	image := materialize(t, v)
	t.Log(string(command(t, "fsck.fat", "-n", image)))
	listing := string(command(t, "mdir", "-i", image, "-/", "-a", "-b", "::/"))
	t.Log(listing)
	for _, name := range []string{"中文 长名字.txt", "MixedCase.TXT", "alpha.txt", "lower.UPP"} {
		if !strings.Contains(listing, name) {
			t.Fatalf("mdir missing %s", name)
		}
	}
	for _, e := range l.Entries {
		if e.Node.Dir || e.Node.Size == 0 {
			continue
		}
		got := command(t, "mtype", "-i", image, "::"+e.Path)
		if !bytes.Equal(got, v.source.(testSource)[e.Node.SourceID]) {
			t.Fatalf("mtype %s: %q", e.Path, got)
		}
	}
	newFile := filepath.Join(t.TempDir(), "new.txt")
	if err := os.WriteFile(newFile, []byte("new data"), 0600); err != nil {
		t.Fatal(err)
	}
	command(t, "mcopy", "-i", image, newFile, "::/new.txt")
	command(t, "mcopy", "-o", "-i", image, newFile, "::/alpha.txt")
	command(t, "mren", "-i", image, "::/MixedCase.TXT", "::/renamed.txt")
	command(t, "mmd", "-i", image, "::/target")
	command(t, "mmove", "-i", image, "::/folder/lower.UPP", "::/target/")
	command(t, "mdel", "-i", image, "::/empty")
	command(t, "mrd", "-i", image, "::/folder")
	command(t, "mmd", "-i", image, "::/nested")
	command(t, "mmd", "-i", image, "::/nested/child")
	command(t, "mcopy", "-i", image, newFile, "::/nested/child/new.txt")
	command(t, "mcopy", "-i", image, newFile, "::/.DS_Store")
	t.Log(string(command(t, "fsck.fat", "-n", image)))
	f, err := os.Open(image)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	o := NewMemoryOverlay(v)
	defer o.Close()
	a, b := make([]byte, overlayBlock), make([]byte, overlayBlock)
	for off := int64(0); off < l.Geometry.Size; off += overlayBlock {
		n := min(int64(overlayBlock), l.Geometry.Size-off)
		if _, err := v.ReadAt(a[:n], off); err != nil {
			t.Fatal(err)
		}
		if _, err := f.ReadAt(b[:n], off); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(a[:n], b[:n]) {
			writeAt(t, o, b[:n], off)
		}
	}
	out := parseOK(t, o)
	plan, err := BuildPlan(tree, l, out, o.DirtyClusters(), PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("summary %+v", plan.Summary)
	for _, s := range plan.Steps {
		t.Logf("%s %s -> %s", s.Op, s.From, s.Path)
	}
	for _, expect := range []struct {
		op Operation
		p  string
	}{{Write, "/new.txt"}, {Write, "/alpha.txt"}, {Write, "/nested/child/new.txt"}, {Mkdir, "/nested"}, {Mkdir, "/nested/child"}, {Delete, "/empty"}, {Rmdir, "/folder"}} {
		if !hasStep(plan, expect.op, expect.p) {
			t.Fatalf("missing %s %s", expect.op, expect.p)
		}
	}
	// Dirty blocks can cover unchanged adjacent file clusters. Either a proven
	// rename or Write+Delete is correct, but the final bytes must be identical.
	for _, p := range []string{"/RENAMED.TXT", "/target/lower.UPP"} {
		n := nodeAt(t, out, p)
		buf := make([]byte, n.Size)
		if _, err := out.ReadFileAt(n, buf, 0); err != nil {
			t.Fatal(err)
		}
	}
	if plan.Summary.Ignored != 1 {
		t.Fatal("metadata was not ignored")
	}
	assertPlanExecution(t, tree, l, out, plan)
}

func TestRealMkfsReader(t *testing.T) {
	requireTools(t)
	name := filepath.Join(t.TempDir(), "mkfs.img")
	f, err := os.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(64 << 20); err != nil {
		t.Fatal(err)
	}
	f.Close()
	command(t, "mkfs.fat", "-F", "32", "-n", "EXTERNAL", name)
	file := filepath.Join(t.TempDir(), "data")
	payload := bytes.Repeat([]byte("external"), 999)
	if err := os.WriteFile(file, payload, 0600); err != nil {
		t.Fatal(err)
	}
	command(t, "mmd", "-i", name, "::/中文目录")
	command(t, "mcopy", "-i", name, file, "::/中文目录/long name.txt")
	f, err = os.Open(name)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	out, err := Parse(context.Background(), f, ReaderOptions{})
	if err != nil {
		t.Fatal(err)
	}
	n := nodeAt(t, out, "/中文目录/long name.txt")
	got := make([]byte, n.Size)
	if _, err := out.ReadFileAt(n, got, 0); err != nil || !bytes.Equal(got, payload) {
		t.Fatal(fmt.Sprintf("external content: %v", err))
	}
}

func TestRealRenameWithoutDataWrites(t *testing.T) {
	requireTools(t)
	tree, _, original := fixture(t)
	l, err := Build(tree, Options{ClusterSize: 4096, Time: testTime})
	if err != nil {
		t.Fatal(err)
	}
	v := NewVolume(l, original.source)
	image := materialize(t, v)
	command(t, "mren", "-i", image, "::/alpha.txt", "::/beta.txt")
	command(t, "mren", "-i", image, "::/folder", "::/renamed")
	f, err := os.Open(image)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	o := NewMemoryOverlay(v)
	defer o.Close()
	a, b := make([]byte, 4096), make([]byte, 4096)
	for off := int64(0); off < l.Geometry.Size; off += 4096 {
		n := min(int64(4096), l.Geometry.Size-off)
		if _, err := v.ReadAt(a[:n], off); err != nil {
			t.Fatal(err)
		}
		if _, err := f.ReadAt(b[:n], off); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(a[:n], b[:n]) {
			writeAt(t, o, b[:n], off)
		}
	}
	r := parseOK(t, o)
	plan, err := BuildPlan(tree, l, r, o.DirtyClusters(), PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Summary.Renamed != 2 || plan.Summary.Created != 0 || plan.Summary.Modified != 0 || plan.Summary.Deleted != 0 {
		t.Fatal(plan.Summary)
	}
	assertPlanExecution(t, tree, l, r, plan)
	command(t, "fsck.fat", "-n", image)
}

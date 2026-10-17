package nasdisk

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/vfat"
)

func testSession(t *testing.T) *session {
	t.Helper()
	root := canonicalTemp(t)
	if err := os.WriteFile(filepath.Join(root, "file"), []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "other"), []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	source, err := OpenSource(root, vfat.Tree{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { source.Close() })
	tree, err := source.Scan(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	layout, err := vfat.Build(tree, vfat.Options{WritableBytes: 256 << 20})
	if err != nil {
		t.Fatal(err)
	}
	overlay := vfat.NewMemoryOverlay(vfat.NewVolume(layout, source))
	t.Cleanup(func() { overlay.Close() })
	directory := filepath.Join(root, PrivateName, "session")
	if err = os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	disk := &Disk{Reader: overlay, Overlay: overlay, Size: layout.Geometry.Size, Released: make(chan struct{}, 1)}
	disk.EnableWrites()
	return &session{status: Status{Config: Config{ID: "session", Root: root, Mode: "rw"}, State: "attached"}, directory: directory, image: "/not-a-lun", source: source, tree: tree, layout: layout, disk: disk}
}

func TestEjectedDiskFreezesAndSafeVolumeCommits(t *testing.T) {
	s := testSession(t)
	if err := s.commit(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if s.state() != "committing" || s.journal == nil || s.journal.Done != len(s.journal.Steps) {
		t.Fatalf("state %s journal %+v", s.state(), s.journal)
	}
	if _, err := s.disk.WriteAt([]byte{1}, 0); err == nil {
		t.Fatal("writes accepted after parse")
	}
}

func TestUnsafeVolumeRequiresDecisionAndCanBeRepaired(t *testing.T) {
	s := testSession(t)
	// Corrupt the boot signature so no validated geometry/files can be offered.
	if _, err := s.disk.WriteAt([]byte{0, 0}, 510); err != nil {
		t.Fatal(err)
	}
	if err := s.commit(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if s.state() != "needs-decision" || s.status.Decision.CanForce {
		t.Fatalf("decision %+v", s.status.Decision)
	}
	// Reattach enables the same overlay; simulate the host repairing the BPB.
	s.disk.EnableWrites()
	if _, err := s.disk.WriteAt([]byte{0x55, 0xaa}, 510); err != nil {
		t.Fatal(err)
	}
	if err := s.commit(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if s.journal == nil {
		t.Fatal("repaired volume did not commit")
	}
}

func TestWarningsRequireExplicitForce(t *testing.T) {
	s := testSession(t)
	// FAT[1] clean-shutdown bit cleared in both FAT copies.
	for i := uint32(0); i < 2; i++ {
		off := int64(s.layout.Geometry.ReservedSectors+i*s.layout.Geometry.FATSectors)*512 + 4
		var value [4]byte
		binary.LittleEndian.PutUint32(value[:], 0x07ffffff)
		if _, err := s.disk.WriteAt(value[:], off); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.commit(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if s.state() != "needs-decision" || !s.status.Decision.CanForce {
		t.Fatalf("decision %+v", s.status.Decision)
	}
	if err := s.commit(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if s.journal == nil {
		t.Fatal("force did not commit")
	}
}

func TestConflictCopyPreservesExternalModification(t *testing.T) {
	s := testSession(t)
	entry := s.layout.Entries[1]
	if _, err := s.disk.WriteAt([]byte("host new"), s.layout.Geometry.ClusterOffset(entry.FirstCluster)); err != nil {
		t.Fatal(err)
	}
	other := s.layout.Entries[2]
	if _, err := s.disk.WriteAt([]byte("othernew"), s.layout.Geometry.ClusterOffset(other.FirstCluster)); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(s.status.Root, "file")
	if err := os.WriteFile(file, []byte("external"), 0600); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Add(time.Second)
	if err := os.Chtimes(file, now, now); err != nil {
		t.Fatal(err)
	}
	if err := s.commit(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if len(s.journal.Conflicts) != 1 {
		t.Fatalf("conflicts %+v", s.journal.Conflicts)
	}
	got, err := os.ReadFile(file)
	if err != nil || string(got) != "external" {
		t.Fatalf("external file overwritten: %q %v", got, err)
	}
	got, err = os.ReadFile(filepath.Join(s.status.Root, s.journal.Conflicts[0].Copy))
	if err != nil || string(got) != "host new" {
		t.Fatalf("conflict copy: %q %v", got, err)
	}
	got, err = os.ReadFile(filepath.Join(s.status.Root, "other"))
	if err != nil || string(got) != "othernew" {
		t.Fatalf("independent write blocked: %q %v", got, err)
	}
}

func TestOverwriteKeepsOriginalInTrash(t *testing.T) {
	s := testSession(t)
	entry := s.layout.Entries[1]
	if _, err := s.disk.WriteAt([]byte("host new"), s.layout.Geometry.ClusterOffset(entry.FirstCluster)); err != nil {
		t.Fatal(err)
	}
	if err := s.commit(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{"file": "host new", PrivateName + "/trash/session/file": "original"} {
		got, err := os.ReadFile(filepath.Join(s.status.Root, name))
		if err != nil || string(got) != want {
			t.Fatalf("%s: %q %v", name, got, err)
		}
	}
}

func TestReadOnlyEjectAndDiscardFinish(t *testing.T) {
	for _, mode := range []string{"ro", "rw"} {
		t.Run(mode, func(t *testing.T) {
			s := testSession(t)
			s.runtimeDir = t.TempDir()
			s.status.Mode = mode
			unmounted := false
			s.unmount = func() error { unmounted = true; return nil }
			result := "discarded"
			if mode == "ro" {
				s.disk.Overlay = nil
				result = "unchanged"
			}
			if err := s.finish(result, nil); err != nil {
				t.Fatal(err)
			}
			if !unmounted || s.state() != "finished" {
				t.Fatal("session not finished")
			}
			data, err := os.ReadFile(s.runtimePath("last.json"))
			if err != nil {
				t.Fatal(err)
			}
			var last Last
			if err = json.Unmarshal(data, &last); err != nil {
				t.Fatal(err)
			}
			if last.Result != result {
				t.Fatalf("last %+v", last)
			}
			data, err = os.ReadFile(filepath.Join(s.status.Root, "file"))
			if err != nil || string(data) != "original" {
				t.Fatalf("source changed: %q %v", data, err)
			}
		})
	}
}

func TestPartialRecoveryDoesNotDeleteUnparsedFiles(t *testing.T) {
	s := testSession(t)
	second := s.layout.Entries[2]
	for i := uint32(0); i < 2; i++ {
		off := int64(s.layout.Geometry.ReservedSectors+i*s.layout.Geometry.FATSectors)*512 + int64(second.FirstCluster)*4
		if _, err := s.disk.WriteAt([]byte{0, 0, 0, 0}, off); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.commit(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if s.state() != "needs-decision" || !s.status.Decision.CanForce {
		t.Fatalf("decision %+v", s.status.Decision)
	}
	if err := s.commit(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if s.journal == nil {
		t.Fatal("partial recovery was not executed")
	}
	for _, name := range []string{"file", "other"} {
		data, err := os.ReadFile(filepath.Join(s.status.Root, name))
		if err != nil || string(data) != "original" {
			t.Fatalf("%s: %q %v", name, data, err)
		}
	}
}

package nasdisk

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/vfat"
)

func TestControlCancelWhileAttaching(t *testing.T) {
	for _, state := range []string{"scanning", "attaching", "attached", "committing"} {
		t.Run(state, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			// macOS sockaddr_un has a short path limit; t.TempDir includes the
			// full test name and can exceed it under /var/folders.
			directory, err := os.MkdirTemp("", "nd-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { os.RemoveAll(directory) })
			listener, err := net.Listen("unix", filepath.Join(directory, "control.sock"))
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			s := &session{status: Status{State: state}, cancel: cancel}
			go s.serve(ctx, listener)
			connection, err := net.Dial("unix", listener.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			defer connection.Close()
			connection.SetDeadline(time.Now().Add(time.Second))
			if err = json.NewEncoder(connection).Encode(control{Action: "cancel"}); err != nil {
				t.Fatal(err)
			}
			var response map[string]any
			if err = json.NewDecoder(connection).Decode(&response); err != nil {
				t.Fatal(err)
			}
			if state == "scanning" || state == "attaching" {
				if response["ok"] != true || ctx.Err() != context.Canceled {
					t.Fatalf("cancel: %v context %v", response, ctx.Err())
				}
			} else if response["error"] != "请先在被控电脑安全弹出" || ctx.Err() != nil {
				t.Fatalf("active disk cancelled: %v", response)
			}
		})
	}
}

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
	return &session{status: Status{Config: Config{ID: "session", Storage: "nas", Path: "/folder", Root: root, Mode: "rw"}, State: "attached"}, directory: directory, image: "/not-a-lun", source: source, tree: tree, layout: layout, disk: disk}
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
			if last.Storage != "nas" || last.Path != "/folder" {
				t.Fatalf("last cannot locate its trash: %+v", last)
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

func TestSnapshotOverlayRecoveryAndCleanup(t *testing.T) {
	for _, version := range []vfat.LayoutVersion{0, vfat.LayoutLegacy, vfat.LayoutAligned} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			root := canonicalTemp(t)
			if err := os.WriteFile(filepath.Join(root, "file"), []byte("original"), 0600); err != nil {
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
			config := Config{ID: "session", Root: root, Mode: "rw", StartedAt: 1700000000}
			opts := vfat.Options{LayoutVersion: version, Size: 64 << 30, Time: time.Unix(config.StartedAt, 0).UTC()}
			if version == 0 {
				opts.LayoutVersion = vfat.LayoutLegacy
			}
			layout, err := vfat.Build(tree, opts)
			if err != nil {
				t.Fatal(err)
			}
			private, directory, err := privateDirectory(root, config.ID, true, source.root)
			if err != nil {
				t.Fatal(err)
			}
			defer private.Close()
			saved := snapshot{Config: config, Tree: tree, Options: opts}
			// An old snapshot has no version field at all, rather than an
			// explicit zero. Preserve that wire format in this regression.
			saved.Options.LayoutVersion = version
			data, err := json.Marshal(saved)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(directory, "snapshot.json"), data, 0600); err != nil {
				t.Fatal(err)
			}
			overlay, err := vfat.OpenFileOverlay(vfat.NewVolume(layout, source), filepath.Join(directory, "overlay"))
			if err != nil {
				t.Fatal(err)
			}
			if _, err = overlay.WriteAt([]byte("host new"), layout.Geometry.ClusterOffset(layout.Entries[1].FirstCluster)); err != nil {
				t.Fatal(err)
			}
			dirty := overlay.DirtyClusters()
			if err = overlay.Close(); err != nil {
				t.Fatal(err)
			}
			config.Recover = "commit"
			s := &session{status: Status{Config: config}, image: "/not-a-lun", runtimeDir: t.TempDir()}
			defer func() {
				if s.disk != nil {
					s.disk.Overlay.Close()
				}
				if s.private != nil {
					s.private.Close()
				}
				if s.source != nil {
					s.source.Close()
				}
			}()
			if err = s.initialize(context.Background()); err != nil {
				t.Fatal(err)
			}
			if s.layout.ID != layout.ID || s.layout.Geometry != layout.Geometry || !reflect.DeepEqual(s.disk.Overlay.DirtyClusters(), dirty) {
				t.Fatal("recovery changed the layout or dirty clusters")
			}
			if err = s.commit(context.Background(), false); err != nil {
				t.Fatal(err)
			}
			if s.journal == nil || s.journal.Done != len(s.journal.Steps) {
				t.Fatal("recovered overlay did not commit")
			}
			if err = s.finish("committed", nil); err != nil {
				t.Fatal(err)
			}
			for name, want := range map[string]string{"file": "host new", PrivateName + "/trash/session/file": "original"} {
				got, err := os.ReadFile(filepath.Join(root, name))
				if err != nil || string(got) != want {
					t.Fatalf("%s: %q %v", name, got, err)
				}
			}
			if _, err = os.Stat(filepath.Join(root, PrivateName, config.ID)); !os.IsNotExist(err) {
				t.Fatalf("session directory remains: %v", err)
			}
		})
	}
}

func TestNewSessionPersistsLayoutVersionAndDiscardRemovesDirectory(t *testing.T) {
	root := canonicalTemp(t)
	s := &session{status: Status{Config: Config{ID: "new", Root: root, Mode: "rw", StartedAt: 1700000000}}, image: "/not-a-lun", runtimeDir: t.TempDir()}
	defer func() {
		if s.disk != nil {
			s.disk.Overlay.Close()
		}
		if s.private != nil {
			s.private.Close()
		}
		if s.source != nil {
			s.source.Close()
		}
	}()
	if err := s.initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(s.directory, "snapshot.json"))
	if err != nil {
		t.Fatal(err)
	}
	var saved snapshot
	if err = json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Options.LayoutVersion != vfat.LayoutAligned {
		t.Fatal("new snapshot omitted layout version")
	}
	if err = s.finish("discarded", nil); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(root, PrivateName, "new")); !os.IsNotExist(err) {
		t.Fatalf("session directory remains: %v", err)
	}
}

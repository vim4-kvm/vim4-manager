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

func TestJournalResumeAfterEveryStep(t *testing.T) {
	for stop := 0; stop < 5; stop++ {
		t.Run(string(rune('0'+stop)), func(t *testing.T) {
			root := t.TempDir()
			session := filepath.Join(root, PrivateName, "session")
			if err := os.MkdirAll(session, 0700); err != nil {
				t.Fatal(err)
			}
			for name, data := range map[string]string{"a": "first", "b": "second", "deleted": "old"} {
				if err := os.WriteFile(filepath.Join(root, name), []byte(data), 0600); err != nil {
					t.Fatal(err)
				}
			}
			j := &Journal{Version: 1, ID: "session", Steps: []journalStep{
				{Op: vfat.Rename, From: "a", Path: "stage-a"},
				{Op: vfat.Rename, From: "b", Path: "a"},
				{Op: vfat.Rename, From: "stage-a", Path: "b"},
				{Op: vfat.Rename, From: "deleted", Path: PrivateName + "/trash/session/deleted"},
				{Op: vfat.Mkdir, Path: "new"},
			}}
			if err := AtomicJSON(filepath.Join(session, "journal"), j); err != nil {
				t.Fatal(err)
			}
			crash := errors.New("crash")
			err := j.Execute(context.Background(), root, session, func(p Progress) error {
				if p.Done == stop+1 {
					return crash
				}
				return nil
			})
			if !errors.Is(err, crash) {
				t.Fatal(err)
			}
			restored, err := LoadJournal(session)
			if err != nil {
				t.Fatal(err)
			}
			if err = restored.Execute(context.Background(), root, session, nil); err != nil {
				t.Fatal(err)
			}
			for name, want := range map[string]string{"a": "second", "b": "first", PrivateName + "/trash/session/deleted": "old"} {
				got, err := os.ReadFile(filepath.Join(root, name))
				if err != nil || string(got) != want {
					t.Fatalf("%s: %q %v", name, got, err)
				}
			}
		})
	}
}

func TestRecoverMutationBeforeCheckpoint(t *testing.T) {
	root := t.TempDir()
	session := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a"), []byte("content"), 0600); err != nil {
		t.Fatal(err)
	}
	j := &Journal{Version: 1, ID: "s", Steps: []journalStep{{Op: vfat.Rename, From: "a", Path: "b"}}}
	r, err := os.OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if err = executeStep(r, session, "s", 0, &j.Steps[0], func() error { return AtomicJSON(filepath.Join(session, "journal"), j) }); err != nil {
		t.Fatal(err)
	}
	// The filesystem mutation happened, but Done was never incremented.
	restored, err := LoadJournal(session)
	if err != nil {
		t.Fatal(err)
	}
	if err = restored.Execute(context.Background(), root, session, nil); err != nil {
		t.Fatal(err)
	}
}

func TestWriteRecoveryAndDestinationProtection(t *testing.T) {
	root := t.TempDir()
	session := t.TempDir()
	if err := os.WriteFile(filepath.Join(session, "payload"), []byte("new content"), 0600); err != nil {
		t.Fatal(err)
	}
	j := &Journal{Version: 1, ID: "s", Steps: []journalStep{{Op: vfat.Write, Path: "file", Payload: "payload", Size: 11, Mtime: time.Unix(1700000000, 0)}}}
	r, err := os.OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if err = executeStep(r, session, "s", 0, &j.Steps[0], func() error { return AtomicJSON(filepath.Join(session, "journal"), j) }); err != nil {
		t.Fatal(err)
	}
	restored, err := LoadJournal(session)
	if err != nil {
		t.Fatal(err)
	}
	if err = restored.Execute(context.Background(), root, session, nil); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(root, "file"))
	if err != nil || string(got) != "new content" {
		t.Fatalf("%q %v", got, err)
	}
	other := &Journal{Version: 1, ID: "other", Steps: []journalStep{{Op: vfat.Write, Path: "file", Payload: "payload", Size: 11}}}
	if err = other.Execute(context.Background(), root, session, nil); err == nil {
		t.Fatal("overwrote unexpected destination")
	}
}

func TestPublishedEntriesIgnorePrivateUmask(t *testing.T) {
	old := syscall.Umask(0077)
	defer syscall.Umask(old)
	root, session := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(session, "payload"), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	j := &Journal{Version: 1, ID: "s", Steps: []journalStep{
		{Op: vfat.Mkdir, Path: "dir"},
		{Op: vfat.Write, Path: "dir/file", Payload: "payload", Size: 1, Mtime: time.Unix(1700000000, 0)},
	}}
	if err := j.Execute(context.Background(), root, session, nil); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]os.FileMode{"dir": 0755, "dir/file": 0644} {
		info, err := os.Stat(filepath.Join(root, name))
		if err != nil || info.Mode().Perm() != want {
			t.Fatalf("%s: %v %v", name, info.Mode(), err)
		}
	}
}

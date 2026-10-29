package nasdisk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/i18n"
	"github.com/vim4-kvm/vim4-manager/internal/vfat"
	"golang.org/x/sys/unix"
)

const Runtime = "/run/vim4-nasdisk"
const LUN = "/sys/kernel/config/usb_gadget/kvm/functions/mass_storage.disk0/lun.0/file"

type Config struct {
	ID               string `json:"id"`
	Storage          string `json:"storage"`
	StorageName      string `json:"storageName"`
	Path             string `json:"path"`
	Mode             string `json:"mode"`
	Label            string `json:"label"`
	Root             string `json:"root"`
	StartedAt        int64  `json:"startedAt"`
	Recover          string `json:"recover,omitempty"`
	Force            bool   `json:"force,omitempty"`
	UTCOffsetMinutes int    `json:"utcOffsetMinutes"`
}
type Decision struct {
	Reason   string `json:"reason"`
	CanForce bool   `json:"canForce"`
}
type Counts struct {
	Mkdirs    int `json:"mkdirs"`
	Writes    int `json:"writes"`
	Renames   int `json:"renames"`
	Deletes   int `json:"deletes"`
	Ignored   int `json:"ignored"`
	Conflicts int `json:"conflicts"`
}
type Skipped struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}
type Status struct {
	Config
	State         string    `json:"state"`
	Scanned       int       `json:"scanned"`
	Files         int       `json:"files"`
	Dirs          int       `json:"dirs"`
	VolumeBytes   int64     `json:"volumeBytes"`
	UsedBytes     int64     `json:"usedBytes"`
	WrittenBytes  int64     `json:"writtenBytes"`
	Skipped       []Skipped `json:"skipped"`
	SkippedCount  int       `json:"skippedCount"`
	HostConnected bool      `json:"hostConnected"`
	NasStalled    bool      `json:"nasStalled"`
	Plan          *Counts   `json:"plan"`
	Progress      *Progress `json:"progress"`
	Decision      *Decision `json:"decision"`
	Error         string    `json:"error"`
	Detail        string    `json:"detail"`
}
type Last struct {
	ID               string     `json:"id"`
	Storage          string     `json:"storage"`
	StorageName      string     `json:"storageName"`
	Path             string     `json:"path"`
	Mode             string     `json:"mode"`
	Result           string     `json:"result"`
	Summary          Counts     `json:"summary"`
	Conflicts        []Conflict `json:"conflicts"`
	Error            string     `json:"error"`
	Detail           string     `json:"detail"`
	UTCOffsetMinutes int        `json:"utcOffsetMinutes"`
	FinishedAt       int64      `json:"finishedAt"`
	Trash            *Trash     `json:"trash"`
}
type Trash struct {
	Bytes int64 `json:"bytes"`
	Files int64 `json:"files"`
}
type snapshot struct {
	Config  Config
	Tree    vfat.Tree
	Options vfat.Options
}
type control struct {
	Action  string `json:"action"`
	ID      string `json:"id"`
	Force   bool   `json:"force"`
	Confirm string `json:"confirm"`
}

type session struct {
	mu         sync.Mutex
	status     Status
	directory  string
	runtimeDir string
	image      string
	source     *Source
	tree       vfat.Tree
	layout     *vfat.Layout
	disk       *Disk
	result     *vfat.Result
	unmount    func() error
	journal    *Journal
	private    *os.File
	commands   chan control
	cancel     context.CancelFunc
}

func Run(ctx context.Context, config Config) error {
	if config.ID == "" || strings.ContainsAny(config.ID, "/\\.") || config.Mode != "ro" && config.Mode != "rw" || config.UTCOffsetMinutes < -720 || config.UTCOffsetMinutes > 840 {
		return fmt.Errorf("invalid session configuration")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if err := CleanupMount(filepath.Join(Runtime, "fs")); err != nil {
		return err
	}
	s := &session{status: Status{Config: config, State: "scanning", Skipped: []Skipped{}}, directory: filepath.Join(config.Root, PrivateName, config.ID), image: filepath.Join(Runtime, "fs", "disk-"+config.ID+".img"), commands: make(chan control, 1), cancel: cancel}
	if err := os.MkdirAll(filepath.Join(Runtime, "fs"), 0755); err != nil {
		return err
	}
	listener, err := net.Listen("unix", filepath.Join(Runtime, "control.sock"))
	if err != nil {
		return err
	}
	defer listener.Close()
	defer os.Remove(filepath.Join(Runtime, "control.sock"))
	if err = os.Chmod(filepath.Join(Runtime, "control.sock"), 0600); err != nil {
		return err
	}
	go s.serve(ctx, listener)
	go s.publish(ctx)
	defer func() {
		if s.private != nil {
			s.private.Close()
		}
		if s.unmount != nil {
			s.unmount()
		}
		if s.disk != nil && s.disk.Overlay != nil {
			s.disk.Overlay.Close()
		}
		if s.source != nil {
			s.source.Close()
		}
	}()
	if err = s.initialize(ctx); err != nil {
		if errors.Is(err, context.Canceled) {
			return s.finish("cancelled", nil)
		}
		s.fail(err)
		s.finish("failed", err)
		return err
	}
	if config.Recover == "discard" {
		return s.finish("discarded", nil)
	}
	if config.Recover != "" {
		s.setState("parsing")
		err = s.commit(ctx, config.Force)
		if err == nil && s.journal != nil {
			return s.finish("committed", nil)
		}
	} else {
		err = s.attach(ctx)
	}
	if errors.Is(err, context.Canceled) {
		return s.finish("cancelled", nil)
	}
	if err != nil {
		s.fail(err)
	}
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			// Release FUSE kernel waiters before taking the disk's I/O lock.
			if s.unmount != nil {
				s.unmount()
				s.unmount = nil
			}
			if s.disk != nil {
				s.disk.Freeze()
			}
			return ctx.Err()
		case command := <-s.commands:
			switch command.Action {
			case "discard":
				if err = s.finish("discarded", nil); err == nil {
					return nil
				}
				s.fail(err)
			case "cancel":
				if err = s.finish("cancelled", nil); err == nil {
					return nil
				}
				s.fail(err)
			case "reattach":
				s.disk.clearWriteTimeout()
				if err = s.attach(ctx); err != nil {
					if errors.Is(err, context.Canceled) {
						return s.finish("cancelled", nil)
					}
					s.fail(err)
				}
			case "commit":
				if err = s.commit(ctx, command.Force); err != nil {
					s.fail(err)
				} else if s.journal != nil {
					return s.finish("committed", nil)
				}
			}
		case <-tick.C:
			if s.state() != "attached" {
				continue
			}
			if err = s.checkEjected(ctx); err != nil {
				s.fail(err)
			} else if s.state() == "finished" {
				return nil
			}
		case <-s.releaseChannel():
			if s.state() == "attached" {
				if err = s.checkEjected(ctx); err != nil {
					s.fail(err)
				} else if s.state() == "finished" {
					return nil
				}
			}
		}
	}
}

func (s *session) releaseChannel() <-chan struct{} {
	if s.disk == nil {
		return nil
	}
	return s.disk.Released
}
func (s *session) state() string { s.mu.Lock(); defer s.mu.Unlock(); return s.status.State }
func (s *session) setState(state string) {
	s.mu.Lock()
	s.status.State = state
	s.status.Error = ""
	s.status.Detail = ""
	s.status.Decision = nil
	s.mu.Unlock()
}
func (s *session) fail(err error) {
	s.mu.Lock()
	s.status.State = "failed"
	s.status.Error = failureMessage(err)
	s.status.Detail = err.Error()
	s.status.Decision = nil
	s.mu.Unlock()
}

func (s *session) initialize(ctx context.Context) error {
	c := s.status.Config
	var saved snapshot
	anchor, err := OpenSource(c.Root, vfat.Tree{})
	if err != nil {
		return err
	}
	s.source = anchor
	if c.Recover != "" {
		f, p, e := privateDirectory(c.Root, c.ID, false, s.source.root)
		if e != nil {
			return e
		}
		s.private = f
		s.directory = p
		b, e := os.ReadFile(filepath.Join(s.directory, "snapshot.json"))
		if e != nil {
			return e
		}
		if e = json.Unmarshal(b, &saved); e != nil {
			return e
		}
		// Snapshots written before layout versioning must retain their exact
		// geometry and ID, which are bound into the overlay index header.
		if saved.Options.LayoutVersion == 0 {
			saved.Options.LayoutVersion = vfat.LayoutLegacy
		}
		if saved.Config.ID != c.ID || saved.Config.Root != c.Root {
			return fmt.Errorf("snapshot identity mismatch")
		}
		s.mu.Lock()
		s.status.UTCOffsetMinutes = saved.Config.UTCOffsetMinutes
		s.mu.Unlock()
		if c.Recover == "discard" {
			return nil
		}
		if j, e := LoadJournal(s.directory); e == nil {
			if j.ID != c.ID {
				return fmt.Errorf("journal session mismatch")
			}
			s.journal = j
			s.mu.Lock()
			s.status.Plan = &j.Counts
			s.status.Progress = &Progress{Done: j.Done, Total: len(j.Steps)}
			s.mu.Unlock()
			return nil
		} else if !errors.Is(e, os.ErrNotExist) {
			return e
		}
	}
	source := anchor
	source.loadTree(saved.Tree)
	var e error
	if c.Recover == "" {
		tree, e := source.Scan(ctx, func(n int) { s.mu.Lock(); s.status.Scanned = n; s.mu.Unlock() })
		if e != nil {
			return e
		}
		saved.Tree = tree
		saved.Config = c
		saved.Options = vfat.Options{LayoutVersion: vfat.LayoutAligned, Label: c.Label, Time: time.Unix(c.StartedAt, 0).UTC(), ExcludeName: PrivateName, UTCOffsetMinutes: c.UTCOffsetMinutes}
		if c.Mode == "rw" {
			var stat unix.Statfs_t
			if e = unix.Fstatfs(int(source.root.Fd()), &stat); e != nil {
				return e
			}
			reserve, e := WritableReserve(int64(stat.Bavail) * int64(stat.Bsize))
			if e != nil {
				return e
			}
			saved.Options.WritableBytes = reserve
		}
	}
	s.tree = saved.Tree
	s.layout, e = vfat.Build(saved.Tree, saved.Options)
	if e != nil {
		return e
	}
	s.mu.Lock()
	s.status.VolumeBytes = s.layout.Geometry.Size
	for _, entry := range s.layout.Entries {
		if entry.Path == "/" {
			continue
		}
		if entry.Node.Dir {
			s.status.Dirs++
		} else {
			s.status.Files++
			s.status.UsedBytes += entry.Node.Size
		}
	}
	s.status.SkippedCount = len(s.layout.Skipped)
	for i, item := range s.layout.Skipped {
		if i == 100 {
			break
		}
		s.status.Skipped = append(s.status.Skipped, Skipped{item.Path, item.Reason})
	}
	s.mu.Unlock()
	volume := vfat.NewVolume(s.layout, s.source)
	disk := &Disk{Reader: volume, Size: s.layout.Geometry.Size, Released: make(chan struct{}, 1)}
	if c.Mode == "rw" {
		if c.Recover == "" {
			f, p, e := privateDirectory(c.Root, c.ID, true, s.source.root)
			if e != nil {
				return e
			}
			s.private = f
			s.directory = p
			if e = AtomicJSON(filepath.Join(s.directory, "snapshot.json"), saved); e != nil {
				return e
			}
		}
		overlay, e := vfat.OpenFileOverlay(volume, filepath.Join(s.directory, "overlay"))
		if e != nil {
			return e
		}
		disk.Overlay = overlay
		disk.Reader = overlay
		disk.written.Store(overlay.WrittenBytes())
	}
	s.mu.Lock()
	s.disk = disk
	s.mu.Unlock()
	return nil
}

func (s *session) attach(ctx context.Context) error {
	if s.disk == nil || s.journal != nil {
		return i18n.New("nasDisk.writebackStarted", nil)
	}
	s.setState("attaching")
	ctx, cancel := context.WithTimeout(ctx, mountTimeout)
	defer cancel()
	if s.unmount == nil {
		unmount, e := MountDisk(ctx, filepath.Dir(s.image), filepath.Base(s.image), s.disk)
		if e != nil {
			return e
		}
		s.unmount = unmount
	}
	s.disk.EnableWrites()
	// A helper blocked in a FUSE syscall cannot reap SIGKILL until the
	// connection is aborted. Abort concurrently with cancellation, before Wait.
	stopAbort := context.AfterFunc(ctx, func() { CleanupMount(filepath.Dir(s.image)) })
	defer stopAbort()
	command := exec.CommandContext(ctx, "/usr/libexec/vim4-manager-helper", "nasdisk-lun-attach", s.status.ID)
	// Let the helper restore gadget settings if cancellation interrupts attach.
	command.Cancel = func() error { return command.Process.Signal(syscall.SIGTERM) }
	command.WaitDelay = time.Second
	output, e := command.CombinedOutput()
	if e != nil {
		if ctx.Err() != nil {
			CleanupMount(filepath.Dir(s.image))
			if ctx.Err() == context.Canceled {
				return ctx.Err()
			}
			return i18n.New("nasDisk.fuseUnavailable", nil)
		}
		s.disk.Freeze()
		return i18n.New("nasDisk.mountFailed", map[string]any{"p0": strings.TrimSpace(string(output))})
	}
	s.setState("attached")
	return nil
}

func (s *session) checkEjected(ctx context.Context) error {
	b, e := os.ReadFile(LUN)
	if e != nil {
		s.mu.Lock()
		s.status.Error = failureMessage(e)
		s.status.Detail = e.Error()
		s.mu.Unlock()
		return nil
	}
	if strings.TrimSpace(string(b)) == s.image {
		return nil
	}
	if s.status.Mode == "ro" {
		s.disk.Freeze()
		return s.finish("unchanged", nil)
	}
	if e = s.commit(ctx, false); e != nil {
		return e
	}
	if s.journal != nil {
		return s.finish("committed", nil)
	}
	return nil
}

func (s *session) commit(ctx context.Context, force bool) error {
	if err := s.requireDetached(); err != nil {
		return err
	}
	if s.journal == nil {
		s.setState("parsing")
		if e := s.disk.Freeze(); e != nil {
			if s.disk.writeTimeout.Load() {
				s.writeTimeoutDecision(false)
				return nil
			}
			return e
		}
		result, e := vfat.Parse(ctx, s.disk.Reader, vfat.ReaderOptions{UTCOffsetMinutes: s.status.UTCOffsetMinutes})
		s.result = result
		canForce := result != nil && result.Geometry == s.layout.Geometry && len(result.Nodes) > 0
		// A timed-out write can become durable after the host received EIO.
		// Host retries or dirty FAT flags cannot prove intent: even a valid
		// volume requires an explicit decision before publishing to the NAS.
		if s.disk.writeTimeout.Load() && !force {
			s.writeTimeoutDecision(canForce)
			return nil
		}
		if (e != nil || !result.Safe || len(result.Warnings) > 0) && (!force || !canForce) {
			reason := (i18n.Message{Key: "nasDisk.checkRequired"}).Render(i18n.English)
			detail := "FAT32 validation did not complete"
			if e != nil {
				reason = failureMessage(e)
				detail = e.Error()
			} else if len(result.Warnings) > 0 {
				reason = (i18n.Message{Key: "nasDisk.unsafeFilesystem"}).Render(i18n.English)
				detail = strings.Join(result.Warnings, "; ")
			}
			s.mu.Lock()
			s.status.State = "needs-decision"
			s.status.Decision = &Decision{reason, canForce}
			s.status.Error = ""
			s.status.Detail = detail
			s.mu.Unlock()
			return nil
		}
		var plan *vfat.Plan
		if !result.Safe {
			plan, e = RecoveryPlan(s.tree, s.layout, result)
		} else {
			plan, e = vfat.BuildPlan(s.tree, s.layout, result, s.disk.Overlay.DirtyClusters(), vfat.PlanOptions{IgnorePatterns: append(vfat.DefaultIgnorePatterns(), PrivateName)})
		}
		if e != nil {
			return e
		}
		s.mu.Lock()
		s.status.Plan = &Counts{Ignored: plan.Summary.Ignored}
		for _, step := range plan.Steps {
			switch step.Op {
			case vfat.Mkdir:
				s.status.Plan.Mkdirs++
			case vfat.Write:
				s.status.Plan.Writes++
			case vfat.Rename:
				if !step.Temporary {
					s.status.Plan.Renames++
				}
			case vfat.Delete, vfat.Rmdir:
				s.status.Plan.Deletes++
			}
		}
		s.mu.Unlock()
		j, e := Prepare(ctx, s.executionRoot(), s.directory, s.status.ID, plan, result)
		if e != nil {
			return e
		}
		s.journal = j
		s.mu.Lock()
		s.status.Plan = &j.Counts
		s.mu.Unlock()
	}
	s.setState("committing")
	return s.journal.Execute(ctx, s.executionRoot(), s.directory, func(p Progress) error { s.mu.Lock(); s.status.Progress = &p; s.mu.Unlock(); return nil })
}

func (s *session) writeTimeoutDecision(canForce bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status.State = "needs-decision"
	s.status.Decision = &Decision{(i18n.Message{Key: "nasDisk.stalled"}).Render(i18n.English), canForce}
	s.status.Error = ""
	s.status.Detail = "A timed-out overlay write or sync may have completed after the host received EIO."
}

func (s *session) executionRoot() string {
	if runtime.GOOS == "linux" && s.source != nil {
		return fmt.Sprintf("/proc/self/fd/%d", s.source.root.Fd())
	}
	return s.status.Root
}

func (s *session) finish(result string, cause error) error {
	if result != "failed" {
		if err := s.requireDetached(); err != nil {
			return err
		}
	}
	last := Last{ID: s.status.ID, Storage: s.status.Storage, StorageName: s.status.StorageName, Path: s.status.Path, Mode: s.status.Mode, Result: result, Conflicts: []Conflict{}, FinishedAt: time.Now().Unix(), UTCOffsetMinutes: s.status.UTCOffsetMinutes}
	if cause != nil {
		last.Error = failureMessage(cause)
		last.Detail = cause.Error()
	}
	if s.status.Plan != nil {
		last.Summary = *s.status.Plan
	}
	if s.journal != nil {
		last.Summary = s.journal.Counts
		last.Conflicts = s.journal.Conflicts
		last.Summary.Conflicts = len(last.Conflicts)
	}
	if e := AtomicJSON(s.runtimePath("last.json"), last); e != nil {
		return e
	}
	if result != "failed" {
		if s.unmount != nil {
			if e := s.unmount(); e != nil {
				return e
			}
			s.unmount = nil
		}
	}
	if result != "failed" && s.status.Mode == "rw" {
		if s.disk != nil && s.disk.Overlay != nil {
			s.disk.Overlay.Close()
		}
		if s.private != nil {
			entries, e := os.ReadDir(s.directory)
			if e != nil {
				return e
			}
			for _, entry := range entries {
				// Keep the completed journal and snapshot until payload cleanup is
				// durable. A restart then resumes cleanup without reparsing a FAT
				// image whose original NAS files have already moved.
				if entry.Name() == "journal" || entry.Name() == "snapshot.json" {
					continue
				}
				if e = os.RemoveAll(filepath.Join(s.directory, entry.Name())); e != nil {
					return e
				}
			}
			if e = s.private.Sync(); e != nil {
				return e
			}
			for _, name := range []string{"journal", "snapshot.json"} {
				if e = os.Remove(filepath.Join(s.directory, name)); e != nil && !errors.Is(e, os.ErrNotExist) {
					return e
				}
				if e = s.private.Sync(); e != nil {
					return e
				}
			}
			// s.directory may be /proc/self/fd/N. Remove the session through
			// its pinned parent, then make the directory removal durable.
			parentFD, e := unix.Openat(int(s.private.Fd()), "..", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
			if e != nil {
				return e
			}
			defer unix.Close(parentFD)
			if e = unix.Unlinkat(parentFD, s.status.ID, unix.AT_REMOVEDIR); e != nil {
				return e
			}
			if e = unix.Fsync(parentFD); e != nil {
				return e
			}
		}
	}
	s.setState("finished")
	err := os.Remove(s.runtimePath("status.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (s *session) runtimePath(name string) string {
	directory := s.runtimeDir
	if directory == "" {
		directory = Runtime
	}
	return filepath.Join(directory, name)
}

func (s *session) requireDetached() error {
	b, err := os.ReadFile(LUN)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(b)) == s.image {
		return i18n.New("nasDisk.ejectRequired", nil)
	}
	return nil
}

func (s *session) publish(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		connected := false
		if controller, err := os.ReadFile("/sys/kernel/config/usb_gadget/kvm/UDC"); err == nil {
			if state, err := os.ReadFile(filepath.Join("/sys/class/udc", strings.TrimSpace(string(controller)), "state")); err == nil {
				connected = strings.TrimSpace(string(state)) == "configured"
			}
		}
		s.mu.Lock()
		s.status.HostConnected = connected
		if s.disk != nil {
			s.status.WrittenBytes = s.disk.Written()
			s.status.NasStalled = s.disk.NasStalled(time.Now())
		}
		if s.status.State != "finished" {
			AtomicJSON(s.runtimePath("status.json"), s.status)
		}
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *session) serve(ctx context.Context, l net.Listener) {
	for {
		conn, e := l.Accept()
		if e != nil {
			return
		}
		func() {
			defer conn.Close()
			conn.SetDeadline(time.Now().Add(5 * time.Second))
			var c control
			if e = json.NewDecoder(conn).Decode(&c); e != nil {
				return
			}
			s.mu.Lock()
			defer s.mu.Unlock()
			var err error
			if c.Action == "status" {
				json.NewEncoder(conn).Encode(s.status)
				return
			}
			if c.ID != "" && c.ID != s.status.ID {
				err = i18n.New("nasDisk.sessionChanged", nil)
			} else {
				switch c.Action {
				case "cancel":
					if s.status.State == "attached" || s.status.State == "committing" {
						err = i18n.New("nasDisk.ejectRequired", nil)
					} else if s.status.State == "scanning" || s.status.State == "attaching" {
						s.cancel()
					} else {
						select {
						case s.commands <- c:
						default:
							err = i18n.New("nasDisk.sessionBusy", nil)
						}
					}
				case "discard", "commit", "reattach":
					if s.status.State != "needs-decision" && s.status.State != "failed" {
						err = i18n.New("nasDisk.invalidOperation", nil)
					} else if c.Action == "discard" && c.Confirm != s.status.ID {
						err = i18n.New("nasDisk.confirmSession", nil)
					} else {
						select {
						case s.commands <- c:
						default:
							err = i18n.New("nasDisk.sessionBusy", nil)
						}
					}
				default:
					err = i18n.New("nasDisk.operationUnsupported", nil)
				}
			}
			if err != nil {
				json.NewEncoder(conn).Encode(map[string]any{"error": err.Error()})
			} else {
				json.NewEncoder(conn).Encode(map[string]bool{"ok": true})
			}
		}()
	}
}

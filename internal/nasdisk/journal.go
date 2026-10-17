package nasdisk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"syscall"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/vfat"
	"golang.org/x/sys/unix"
)

// AtomicJSON publishes a complete document and persists its directory entry.
func AtomicJSON(name string, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(path.Dir(name), ".json-")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(tmp, name); err != nil {
		return err
	}
	dir, err := os.Open(path.Dir(name))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

type Conflict struct {
	Path string `json:"path"`
	Copy string `json:"copy"`
}
type Progress struct {
	Done       int    `json:"done"`
	Total      int    `json:"total"`
	BytesDone  int64  `json:"bytesDone"`
	BytesTotal int64  `json:"bytesTotal"`
	Current    string `json:"current"`
}

type journalStep struct {
	Op      vfat.Operation
	Path    string
	From    string
	Mtime   time.Time
	Payload string
	Size    int64
	// Before is persisted before the mutation. Recovery distinguishes an applied
	// rename from an untouched source instead of repeating a destructive step.
	Before *identity
}

type identity struct {
	Size  int64
	Mtime time.Time
	Dir   bool
	Inode uint64
}

func identify(info os.FileInfo) *identity {
	id := &identity{Size: info.Size(), Mtime: info.ModTime(), Dir: info.IsDir()}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		id.Inode = stat.Ino
	}
	return id
}
func sameIdentity(a, b *identity) bool {
	return a != nil && b != nil && a.Size == b.Size && a.Mtime.Equal(b.Mtime) && a.Dir == b.Dir && a.Inode == b.Inode
}

type Journal struct {
	Version   int
	ID        string
	Steps     []journalStep
	Done      int
	Conflicts []Conflict
	Summary   vfat.Summary
	Counts    Counts
}

// Prepare checks every precondition before staging any mutation. All Write
// payloads are materialized before NAS originals move: the FAT source may still
// depend on their original paths. A published journal never depends on the FAT
// image and can be resumed after a reboot or a partial rename sequence.
func Prepare(ctx context.Context, root, session, id string, plan *vfat.Plan, result *vfat.Result) (*Journal, error) {
	r, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	changed := map[string]bool{}
	for _, s := range plan.Preconditions {
		info, e := r.Lstat(strings.TrimPrefix(s.Path, "/"))
		if e != nil && !errors.Is(e, os.ErrNotExist) {
			return nil, e
		}
		if e != nil || info.Mode()&os.ModeSymlink != 0 || info.IsDir() != s.Dir || (!s.Dir && info.Size() != s.Size) || !info.ModTime().Equal(s.Mtime) {
			changed[s.Path] = true
		}
	}
	for _, p := range plan.AbsentPaths {
		if _, e := r.Lstat(strings.TrimPrefix(p, "/")); e == nil {
			changed[p] = true
		} else if !errors.Is(e, os.ErrNotExist) {
			return nil, e
		}
	}
	// Propagate a blocked rename to its final destination. Otherwise a later
	// child Write could depend on a parent which was deliberately not moved.
	for _, step := range plan.Steps {
		if step.Op == vfat.Rename && step.Original != nil && changed[step.Original.Path] {
			changed[step.Path] = true
		}
	}
	// A changed descendant prevents moving/deleting its parent directory too.
	conflicted := func(p string) bool {
		for c := range changed {
			if p == c || strings.HasPrefix(p, c+"/") || strings.HasPrefix(c, p+"/") {
				return true
			}
		}
		return false
	}
	steps := append([]vfat.Step(nil), plan.Steps...)
	// A conflicting directory rename must still export its identifiable final
	// files. Never move the NAS directory containing someone else's changes.
	for _, step := range plan.Steps {
		if step.Op != vfat.Rename || step.Temporary || step.Original == nil || !step.Original.Dir || !conflicted(step.Original.Path) {
			continue
		}
		changed[step.Path] = true
		for _, node := range result.Nodes {
			if !node.Dir && strings.HasPrefix(node.Path, step.Path+"/") {
				steps = append(steps, vfat.Step{Op: vfat.Write, Path: node.Path, File: &node, Mtime: node.Mtime})
			}
		}
	}
	j := &Journal{Version: 1, ID: id, Summary: plan.Summary, Conflicts: []Conflict{}}
	for _, step := range plan.Steps {
		switch step.Op {
		case vfat.Mkdir:
			j.Counts.Mkdirs++
		case vfat.Write:
			j.Counts.Writes++
		case vfat.Rename:
			if !step.Temporary {
				j.Counts.Renames++
			}
		case vfat.Delete, vfat.Rmdir:
			j.Counts.Deletes++
		}
	}
	j.Counts.Ignored = plan.Summary.Ignored
	reserved := map[string]bool{}
	exported := map[string]bool{}
	for _, s := range steps {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		bad := conflicted(s.Path) || (s.Original != nil && conflicted(s.Original.Path))
		if bad && s.Op == vfat.Rename && !s.Temporary && s.Original != nil && !s.Original.Dir {
			for _, node := range result.Nodes {
				if node.Path == s.Path && !node.Dir {
					s.Op = vfat.Write
					s.File = &node
					s.Mtime = node.Mtime
					break
				}
			}
		}
		if bad && s.Op != vfat.Write {
			if s.Op == vfat.Delete || s.Op == vfat.Rmdir {
				j.Conflicts = append(j.Conflicts, Conflict{Path: s.Path, Copy: ""})
			}
			continue
		}
		if s.Op == vfat.Write {
			if exported[s.Path] {
				continue
			}
			exported[s.Path] = true
		}
		step := journalStep{Op: s.Op, Path: strings.TrimPrefix(s.Path, "/"), From: strings.TrimPrefix(s.From, "/"), Mtime: s.Mtime}
		if bad {
			parent := path.Dir(step.Path)
			for parent != "." {
				info, e := r.Lstat(parent)
				if e == nil && info.IsDir() {
					break
				}
				if e != nil && !errors.Is(e, os.ErrNotExist) {
					return nil, e
				}
				parent = path.Dir(parent)
			}
			for attempt := 0; ; attempt++ {
				candidate := path.Join(parent, vfat.ConflictName(path.Base(step.Path), time.Now().UTC().Add(time.Duration(attempt)*time.Second)))
				if reserved[candidate] {
					continue
				}
				if _, e := r.Lstat(candidate); errors.Is(e, os.ErrNotExist) {
					step.Path = candidate
					reserved[candidate] = true
					break
				} else if e != nil {
					return nil, e
				}
			}
			j.Conflicts = append(j.Conflicts, Conflict{s.Path, "/" + step.Path})
		}
		if s.Op == vfat.Write {
			if s.File == nil {
				return nil, fmt.Errorf("write missing final file")
			}
			step.Size = s.File.Size
			f, e := os.CreateTemp(session, "payload-")
			if e != nil {
				return nil, e
			}
			step.Payload = path.Base(f.Name())
			buf := make([]byte, 128<<10)
			for off := int64(0); off < s.File.Size; {
				if e = ctx.Err(); e != nil {
					break
				}
				n := int(min(int64(len(buf)), s.File.Size-off))
				var got int
				got, e = result.ReadRecoveredFileAt(*s.File, buf[:n], off)
				if e != nil {
					e = &payloadReadError{Path: s.File.Path, Err: e}
					break
				}
				if got != n {
					e = &payloadReadError{Path: s.File.Path, Err: io.ErrUnexpectedEOF}
					break
				}
				_, e = f.Write(buf[:n])
				if e != nil {
					break
				}
				off += int64(n)
			}
			if e == nil {
				e = f.Sync()
			}
			ce := f.Close()
			if e != nil {
				return nil, e
			}
			if ce != nil {
				return nil, ce
			}
			if s.Original != nil && !bad {
				j.Steps = append(j.Steps, journalStep{Op: vfat.Rename, From: step.Path, Path: path.Join(PrivateName, "trash", id, strings.TrimPrefix(s.Original.Path, "/"))})
			}
		}
		if s.Op == vfat.Delete {
			step.Op = vfat.Rename
			step.From = step.Path
			step.Path = path.Join(PrivateName, "trash", id, strings.TrimPrefix(s.Original.Path, "/"))
		}
		j.Steps = append(j.Steps, step)
	}
	j.Counts.Conflicts = len(j.Conflicts)
	if err := AtomicJSON(path.Join(session, "journal"), j); err != nil {
		return nil, err
	}
	return j, nil
}

func LoadJournal(session string) (*Journal, error) {
	b, e := os.ReadFile(path.Join(session, "journal"))
	if e != nil {
		return nil, e
	}
	var j Journal
	if e = json.Unmarshal(b, &j); e != nil {
		return nil, e
	}
	if j.Version != 1 || j.Done < 0 || j.Done > len(j.Steps) {
		return nil, fmt.Errorf("invalid journal")
	}
	for _, step := range j.Steps {
		if step.Op == vfat.Write && (step.Payload == "" || path.Base(step.Payload) != step.Payload || !strings.HasPrefix(step.Payload, "payload")) {
			return nil, fmt.Errorf("invalid journal payload")
		}
	}
	return &j, nil
}

// Execute only observes cancellation between durable steps. afterStep is useful
// for progress publication and deterministic crash/restart testing.
func (j *Journal) Execute(ctx context.Context, root, session string, afterStep func(Progress) error) error {
	r, e := os.OpenRoot(root)
	if e != nil {
		return e
	}
	defer r.Close()
	var bytesDone, bytesTotal int64
	for i, step := range j.Steps {
		bytesTotal += step.Size
		if i < j.Done {
			bytesDone += step.Size
		}
	}
	for j.Done < len(j.Steps) {
		if e = ctx.Err(); e != nil {
			return e
		}
		s := &j.Steps[j.Done]
		if e = executeStep(r, session, j.ID, j.Done, s, func() error { return AtomicJSON(path.Join(session, "journal"), j) }); e != nil {
			return fmt.Errorf("%s %s: %w", s.Op, s.Path, e)
		}
		j.Done++
		bytesDone += s.Size
		if e = AtomicJSON(path.Join(session, "journal"), j); e != nil {
			return e
		}
		if afterStep != nil {
			if e = afterStep(Progress{Done: j.Done, Total: len(j.Steps), Current: s.Path, BytesDone: bytesDone, BytesTotal: bytesTotal}); e != nil {
				return e
			}
		}
	}
	return nil
}

func executeStep(r *os.Root, session, id string, index int, s *journalStep, save func() error) error {
	// Root constrains every operation even if another NAS client replaces a
	// parent. Reject symlinks before touching a final destination as well.
	for _, p := range []string{s.Path, s.From} {
		if p == "" {
			continue
		}
		if !path.IsAbs(p) && path.Clean(p) == p && p != ".." && !strings.HasPrefix(p, "../") {
		} else {
			return fmt.Errorf("invalid journal path")
		}
		for part := p; part != "."; part = path.Dir(part) {
			info, e := r.Lstat(part)
			if e != nil && !errors.Is(e, os.ErrNotExist) {
				return e
			}
			if e == nil && info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("symlink in writeback path")
			}
		}
	}
	switch s.Op {
	case vfat.Mkdir:
		e := r.Mkdir(s.Path, 0770)
		if errors.Is(e, os.ErrExist) {
			info, se := r.Stat(s.Path)
			if se == nil && info.IsDir() {
				return syncParents(r, s.Path)
			}
		}
		if e != nil {
			return e
		}
		return syncParents(r, s.Path)
	case vfat.Rename:
		if e := r.MkdirAll(path.Dir(s.Path), 0770); e != nil {
			return e
		}
		from, e := r.Lstat(s.From)
		if s.Before == nil {
			if e != nil {
				return e
			}
			s.Before = identify(from)
			if e = save(); e != nil {
				return e
			}
		}
		to, te := r.Lstat(s.Path)
		if errors.Is(e, os.ErrNotExist) && te == nil && sameIdentity(s.Before, identify(to)) {
			return nil
		}
		if e != nil {
			return e
		}
		if te == nil {
			return fmt.Errorf("destination appeared during writeback")
		}
		if !errors.Is(te, os.ErrNotExist) {
			return te
		}
		if !sameIdentity(s.Before, identify(from)) {
			return fmt.Errorf("source changed during writeback")
		}
		if e = r.Rename(s.From, s.Path); e != nil {
			return e
		}
		return syncParents(r, s.From, s.Path)
	case vfat.Write:
		tmp := path.Join(path.Dir(s.Path), fmt.Sprintf(".vim4-write-%s-%d", id, index))
		// The exclusive temp is left until installation, so recovery can tell a
		// completed rename from an incomplete copy without overwriting a target.
		if s.Before != nil {
			info, e := r.Lstat(s.Path)
			if e == nil && sameIdentity(s.Before, identify(info)) {
				return nil
			}
		}
		if _, e := r.Lstat(s.Path); !errors.Is(e, os.ErrNotExist) {
			if e == nil {
				return fmt.Errorf("write destination exists")
			}
			return e
		}
		if s.Before == nil {
			// An interrupted copy is disposable; it has never been published.
			if e := r.Remove(tmp); e != nil && !errors.Is(e, os.ErrNotExist) {
				return e
			}
			f, e := r.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0660)
			if e != nil {
				return e
			}
			fd, e := unix.Open(path.Join(session, s.Payload), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
			if e != nil {
				f.Close()
				return e
			}
			in := os.NewFile(uintptr(fd), s.Payload)
			info, e := in.Stat()
			if e != nil || !info.Mode().IsRegular() {
				in.Close()
				f.Close()
				return fmt.Errorf("invalid payload file")
			}
			n, e := io.Copy(f, in)
			in.Close()
			if e == nil && n != s.Size {
				e = io.ErrUnexpectedEOF
			}
			if e == nil {
				e = f.Sync()
			}
			ce := f.Close()
			if e != nil {
				return e
			}
			if ce != nil {
				return ce
			}
			if e = r.Chtimes(tmp, s.Mtime, s.Mtime); e != nil {
				return e
			}
			if e = syncFile(r, tmp); e != nil {
				return e
			}
			info, e = r.Stat(tmp)
			if e != nil {
				return e
			}
			s.Before = identify(info)
			if e = save(); e != nil {
				return e
			}
		}
		if e := r.Rename(tmp, s.Path); e != nil {
			return e
		}
		return syncParents(r, s.Path)
	case vfat.Rmdir:
		e := r.Remove(s.Path)
		if errors.Is(e, os.ErrNotExist) {
			return nil
		}
		if e != nil {
			return e
		}
		return syncParents(r, s.Path)
	case vfat.SetTime:
		if e := r.Chtimes(s.Path, s.Mtime, s.Mtime); e != nil {
			return e
		}
		return syncFile(r, s.Path)
	default:
		return fmt.Errorf("unsupported journal operation")
	}
}

func syncParents(r *os.Root, names ...string) error {
	seen := map[string]bool{}
	for _, name := range names {
		for parent := path.Dir(name); ; parent = path.Dir(parent) {
			if !seen[parent] {
				if e := syncFile(r, parent); e != nil {
					return e
				}
				seen[parent] = true
			}
			if parent == "." {
				break
			}
		}
	}
	return nil
}

func syncFile(r *os.Root, name string) error {
	f, e := r.Open(name)
	if e != nil {
		return e
	}
	defer f.Close()
	return f.Sync()
}

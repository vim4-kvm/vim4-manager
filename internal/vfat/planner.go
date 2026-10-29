package vfat

import (
	"fmt"
	"path"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode/utf16"
)

type Operation string

const (
	Mkdir   Operation = "mkdir"
	Rename  Operation = "rename"
	Write   Operation = "write"
	Delete  Operation = "delete" // Executor moves the file into its recycle directory.
	Rmdir   Operation = "rmdir"  // Only after every child operation has completed.
	SetTime Operation = "set-time"
)

type Snapshot struct {
	Path     string
	Size     int64
	Mtime    time.Time
	SourceID SourceID
	Dir      bool
}
type Step struct {
	Op         Operation
	Path, From string
	Original   *Snapshot   // Original NAS path, even when an earlier step moved it.
	File       *ParsedNode // Write reads this node through Result.ReadFileAt.
	Mtime      time.Time
	Temporary  bool
}
type Summary struct{ Created, Modified, Renamed, Deleted, Ignored, PendingConflicts int }
type Plan struct {
	Steps         []Step
	Summary       Summary
	Preconditions []Snapshot // Check ALL at original paths before executing any step.
	AbsentPaths   []string   // Must be absent before execution, including staging names.
}
type PlanOptions struct {
	// Nil uses DefaultIgnorePatterns; an empty non-nil slice disables ignoring.
	IgnorePatterns []string // path.Match patterns matched against every component.
}

func DefaultIgnorePatterns() []string {
	return []string{".fseventsd", ".Spotlight-V100", ".Trashes", ".TemporaryItems", "._*", ".DS_Store", "System Volume Information", "$RECYCLE.BIN"}
}
func ignored(p string, patterns []string) bool {
	for _, part := range strings.Split(strings.Trim(p, "/"), "/") {
		for _, pattern := range patterns {
			if ok, _ := path.Match(strings.ToLower(pattern), strings.ToLower(part)); ok {
				return true
			}
		}
	}
	return false
}
func under(p, dir string) bool { return p == dir || strings.HasPrefix(p, dir+"/") }
func depth(p string) int       { return strings.Count(p, "/") }
func pathLess(a, b string, descending bool) bool {
	if depth(a) != depth(b) {
		if descending {
			return depth(a) > depth(b)
		}
		return depth(a) < depth(b)
	}
	return a < b
}

// remapPath applies the closest mapped ancestor, never a sequence of renames.
func remapPath(p string, targets map[string]string) string {
	for ancestor := p; ancestor != "/" && ancestor != "."; ancestor = path.Dir(ancestor) {
		if to, ok := targets[ancestor]; ok {
			return to + strings.TrimPrefix(p, ancestor)
		}
	}
	return p
}

// BuildPlan requires a successful Parse. Check all Preconditions and AbsentPaths
// against the NAS before ANY step and reserve staging paths exclusively. Swaps
// and occupied destinations require staging before directory installation; new
// directories otherwise come first. Parent dependencies override operation kind.
// Recycling, Rmdir and final directory timestamps come last. A destination that
// would replace an excluded snapshot item is rejected instead of overwriting it.
func BuildPlan(snapshot Tree, l *Layout, final *Result, dirty []ClusterRange, opts PlanOptions) (*Plan, error) {
	if final == nil || !final.Safe {
		return nil, fmt.Errorf("cannot plan an inconsistent filesystem")
	}
	if l.Geometry != final.Geometry {
		return nil, fmt.Errorf("final volume geometry changed")
	}
	patterns := opts.IgnorePatterns
	if patterns == nil {
		patterns = DefaultIgnorePatterns()
	}
	for _, pattern := range patterns {
		if _, err := path.Match(pattern, ""); err != nil {
			return nil, err
		}
	}
	for _, r := range dirty {
		if r.Start < 2 || r.End < r.Start || r.End >= l.Geometry.Clusters+2 {
			return nil, fmt.Errorf("invalid dirty cluster range")
		}
	}
	b, err := newPlanBuilder(snapshot, l, final, patterns)
	if err != nil {
		return nil, err
	}
	b.claimOrigins(dirty)
	if err := b.classifyChanges(); err != nil {
		return nil, err
	}
	b.stageChanges()
	b.installFinal()
	b.orderSteps()
	b.preconditions()
	return &b.plan, nil
}

type plannedMove struct{ from, to, temp string }
type planBuilder struct {
	layout                           *Layout
	plan                             Plan
	patterns                         []string
	finals                           []ParsedNode
	finalByPath                      map[string]ParsedNode
	snapshots                        map[string]*Snapshot
	originals                        map[string]*Entry
	byCluster                        map[uint32]*Entry
	origins                          map[string]*Entry
	claimed                          map[string]bool
	dirTargets                       map[string]string
	replacements                     map[string]*Entry
	protected                        []string
	ignoredPaths                     map[string]bool
	reserved                         map[string]bool
	moves                            map[string]*plannedMove
	removals                         []*Entry
	removalPaths                     map[string]string
	staging, installs, writes, times []Step
	tempIndex                        int
}

func newPlanBuilder(snapshot Tree, l *Layout, final *Result, patterns []string) (*planBuilder, error) {
	b := &planBuilder{
		layout: l, patterns: patterns, finals: append([]ParsedNode(nil), final.Nodes...),
		finalByPath: map[string]ParsedNode{}, snapshots: map[string]*Snapshot{},
		originals: map[string]*Entry{}, byCluster: map[uint32]*Entry{},
		origins: map[string]*Entry{}, claimed: map[string]bool{},
		dirTargets: map[string]string{}, replacements: map[string]*Entry{},
		reserved: map[string]bool{}, moves: map[string]*plannedMove{},
		removalPaths: map[string]string{}, ignoredPaths: map[string]bool{},
	}
	if err := b.indexSnapshot(snapshot.Children, "", 0); err != nil {
		return nil, err
	}
	for _, e := range l.Entries {
		if e.Path == "/" {
			continue
		}
		s := b.snapshots[e.Path]
		if s == nil || s.Size != e.Node.Size || s.Dir != e.Node.Dir || s.SourceID != e.Node.SourceID {
			return nil, fmt.Errorf("snapshot does not match layout at %s", e.Path)
		}
		b.originals[e.Path] = e
		if e.FirstCluster != 0 {
			b.byCluster[e.FirstCluster] = e
		}
		if ignored(e.Path, patterns) {
			b.protected = append(b.protected, e.Path)
		}
	}
	for _, s := range l.Skipped {
		b.protected = append(b.protected, s.Path)
		b.recordIgnored(s.Path)
	}
	sort.Slice(b.finals, func(i, j int) bool { return pathLess(b.finals[i].Path, b.finals[j].Path, false) })
	for _, n := range b.finals {
		if _, ok := b.finalByPath[n.Path]; ok {
			return nil, fmt.Errorf("duplicate final path")
		}
		b.finalByPath[n.Path] = n
		b.reserved[n.Path] = true
	}
	return b, nil
}

func (b *planBuilder) indexSnapshot(nodes []Node, parent string, level int) error {
	if level > 1024 {
		return fmt.Errorf("snapshot depth exceeds plan limit")
	}
	for _, n := range nodes {
		p := parent + "/" + n.Name
		size := n.Size
		if n.Dir {
			size = 0
		}
		b.snapshots[p] = &Snapshot{p, size, n.Mtime, n.SourceID, n.Dir}
		b.reserved[p] = true
		if n.Dir {
			if err := b.indexSnapshot(n.Children, p, level+1); err != nil {
				return err
			}
		}
	}
	return nil
}

func (b *planBuilder) claimOrigins(dirty []ClusterRange) {
	for _, n := range b.finals {
		if n.Path == "/" {
			continue
		}
		if ignored(n.Path, b.patterns) {
			b.recordIgnored(n.Path)
			continue
		}
		e := b.byCluster[n.FirstCluster]
		if e == nil && n.FirstCluster == 0 {
			e = b.originals[n.Path]
		}
		if e == nil || e.Node.Dir != n.Dir || ignored(e.Path, b.patterns) || b.claimed[e.Path] {
			continue
		}
		if !n.Dir && (e.Node.Size != n.Size || !slices.Equal(e.Chain, n.Chain) || overlaps(n.Chain, dirty)) {
			continue
		}
		b.claimed[e.Path] = true
		b.origins[n.Path] = e
		if n.Dir {
			b.dirTargets[e.Path] = n.Path
		}
	}
}

func (b *planBuilder) protects(p string) bool {
	for _, s := range b.protected {
		if under(s, p) {
			return true
		}
	}
	return false
}

func (b *planBuilder) classifyChanges() error {
	for _, n := range b.finals {
		if n.Path == "/" || ignored(n.Path, b.patterns) {
			continue
		}
		for _, s := range b.protected {
			mapped := remapPath(s, b.dirTargets)
			if under(n.Path, mapped) || (under(mapped, n.Path) && !n.Dir) {
				return fmt.Errorf("final path %s collides with excluded snapshot item %s", n.Path, s)
			}
		}
		if e := b.origins[n.Path]; e != nil {
			expected := remapPath(e.Path, b.dirTargets)
			if e.Node.Dir {
				expected = path.Join(remapPath(path.Dir(e.Path), b.dirTargets), path.Base(e.Path))
			}
			if expected != n.Path {
				b.moves[n.Path] = &plannedMove{from: e.Path, to: n.Path}
				b.plan.Summary.Renamed++
			}
		}
	}
	for _, e := range b.layout.Entries {
		if e.Path == "/" || b.claimed[e.Path] {
			continue
		}
		if ignored(e.Path, b.patterns) || b.protects(e.Path) {
			b.recordIgnored(e.Path)
			continue
		}
		dest := remapPath(e.Path, b.dirTargets)
		n, exists := b.finalByPath[dest]
		if exists && !n.Dir && !e.Node.Dir && !ignored(dest, b.patterns) && b.origins[dest] == nil {
			b.replacements[dest] = e
			continue
		}
		b.removals = append(b.removals, e)
	}
	return nil
}

func (b *planBuilder) temporaryPath() string {
	for {
		b.tempIndex++
		p := fmt.Sprintf("/.vim4-stage-%x-%d", b.layout.ID[:6], b.tempIndex)
		if !b.reserved[p] {
			b.reserved[p] = true
			b.plan.AbsentPaths = append(b.plan.AbsentPaths, p)
			return p
		}
	}
}

func (b *planBuilder) recordIgnored(p string) {
	if !b.ignoredPaths[p] {
		b.ignoredPaths[p] = true
		b.plan.Summary.Ignored++
	}
}

func (b *planBuilder) stageChanges() {
	var moves []*plannedMove
	for _, m := range b.moves {
		moves = append(moves, m)
	}
	sort.Slice(moves, func(i, j int) bool { return pathLess(moves[i].from, moves[j].from, true) })
	for _, m := range moves {
		m.temp = b.temporaryPath()
		b.staging = append(b.staging, Step{Op: Rename, From: m.from, Path: m.temp, Original: b.snapshots[m.from], Temporary: true})
	}
	sort.Slice(b.removals, func(i, j int) bool { return pathLess(b.removals[i].Path, b.removals[j].Path, false) })
	stagedParents := map[string]string{}
	for _, e := range b.removals {
		if mapped := remapPath(e.Path, stagedParents); mapped != e.Path {
			b.removalPaths[e.Path] = mapped
			continue
		}
		dest := remapPath(e.Path, b.dirTargets)
		if _, exists := b.finalByPath[dest]; exists {
			temp := b.temporaryPath()
			b.staging = append(b.staging, Step{Op: Rename, From: e.Path, Path: temp, Original: b.snapshots[e.Path], Temporary: true})
			b.removalPaths[e.Path] = temp
			if e.Node.Dir {
				stagedParents[e.Path] = temp
			}
		} else {
			b.removalPaths[e.Path] = dest
		}
	}
	sort.Slice(b.staging, func(i, j int) bool { return pathLess(b.staging[i].From, b.staging[j].From, true) })
}

func (b *planBuilder) installFinal() {
	for _, n := range b.finals {
		if n.Path == "/" || ignored(n.Path, b.patterns) {
			continue
		}
		e := b.origins[n.Path]
		var guard *Snapshot
		if e != nil {
			guard = b.snapshots[e.Path]
		}
		if m := b.moves[n.Path]; m != nil {
			b.installs = append(b.installs, Step{Op: Rename, From: m.temp, Path: n.Path, Original: guard})
		}
		if n.Dir {
			if e == nil {
				b.installs = append(b.installs, Step{Op: Mkdir, Path: n.Path, Mtime: n.Mtime})
				b.plan.Summary.Created++
			}
			if e == nil || !sameFATTime(e.Node.Mtime, n.Mtime, b.layout.location) || e.Path != n.Path {
				b.times = append(b.times, Step{Op: SetTime, Path: n.Path, Original: guard, Mtime: n.Mtime})
			}
		} else if e != nil {
			if !sameFATTime(e.Node.Mtime, n.Mtime, b.layout.location) {
				b.times = append(b.times, Step{Op: SetTime, Path: n.Path, Original: guard, Mtime: n.Mtime})
			}
		} else {
			if old := b.replacements[n.Path]; old != nil {
				guard = b.snapshots[old.Path]
			}
			copyNode := n
			b.writes = append(b.writes, Step{Op: Write, Path: n.Path, Original: guard, File: &copyNode, Mtime: n.Mtime})
			if guard == nil {
				b.plan.Summary.Created++
			} else {
				b.plan.Summary.Modified++
			}
		}
	}
}

func (b *planBuilder) orderSteps() {
	var deferred []Step
	for _, s := range b.installs {
		early := s.Op == Mkdir
		for _, st := range b.staging {
			if under(s.Path, st.From) {
				early = false
			}
		}
		for target := range b.moves {
			if under(s.Path, target) {
				early = false
			}
		}
		if early {
			b.plan.Steps = append(b.plan.Steps, s)
		} else {
			deferred = append(deferred, s)
		}
	}
	b.plan.Steps = append(b.plan.Steps, b.staging...)
	b.plan.Steps = append(b.plan.Steps, deferred...)
	b.plan.Steps = append(b.plan.Steps, b.writes...)
	sort.Slice(b.removals, func(i, j int) bool { return pathLess(b.removals[i].Path, b.removals[j].Path, true) })
	for _, e := range b.removals {
		op := Delete
		if e.Node.Dir {
			op = Rmdir
		}
		b.plan.Steps = append(b.plan.Steps, Step{Op: op, Path: b.removalPaths[e.Path], Original: b.snapshots[e.Path]})
		b.plan.Summary.Deleted++
	}
	b.restoreParentTimes()
	sort.Slice(b.times, func(i, j int) bool { return pathLess(b.times[i].Path, b.times[j].Path, true) })
	b.plan.Steps = append(b.plan.Steps, b.times...)
}

func (b *planBuilder) restoreParentTimes() {
	added := map[string]bool{}
	for _, s := range b.times {
		added[s.Path] = true
	}
	for _, s := range b.plan.Steps {
		for _, changed := range []string{s.Path, s.From} {
			parent := path.Dir(changed)
			n, exists := b.finalByPath[parent]
			if !exists || parent == "/" || !n.Dir || added[parent] || ignored(parent, b.patterns) {
				continue
			}
			var guard *Snapshot
			if e := b.origins[parent]; e != nil {
				guard = b.snapshots[e.Path]
			}
			b.times = append(b.times, Step{Op: SetTime, Path: parent, Original: guard, Mtime: n.Mtime})
			added[parent] = true
		}
	}
}

func (b *planBuilder) preconditions() {
	guarded := map[string]bool{}
	var directories []string
	for _, s := range b.plan.Steps {
		if s.Original != nil {
			guarded[s.Original.Path] = true
			if s.Original.Dir {
				directories = append(directories, s.Original.Path)
			}
		}
		if (s.Op == Mkdir || s.Op == Write || s.Op == Rename) && b.snapshots[s.Path] == nil && !s.Temporary {
			b.plan.AbsentPaths = append(b.plan.AbsentPaths, s.Path)
		}
	}
	// Directory operations must also guard excluded/ignored descendants they carry.
	for p := range b.snapshots {
		for _, dir := range directories {
			if under(p, dir) {
				guarded[p] = true
				break
			}
		}
	}
	for p := range guarded {
		b.plan.Preconditions = append(b.plan.Preconditions, *b.snapshots[p])
	}
	sort.Slice(b.plan.Preconditions, func(i, j int) bool { return b.plan.Preconditions[i].Path < b.plan.Preconditions[j].Path })
	sort.Strings(b.plan.AbsentPaths)
	b.plan.AbsentPaths = slices.Compact(b.plan.AbsentPaths)
	b.plan.Summary.PendingConflicts = len(b.plan.Preconditions)
}

func sameFATTime(a, b time.Time, location *time.Location) bool {
	ad, at := fatTime(a, location)
	bd, bt := fatTime(b, location)
	return ad == bd && at == bt
}

// ConflictName uses UTC and preserves the extension when possible, shortening
// the original name at rune boundaries to remain within 255 UTF-16 units.
func ConflictName(name string, at time.Time) string {
	base, ext := splitName(name)
	suffix := " (conflict " + at.UTC().Format("20060102-150405") + ")"
	if ext != "" {
		ext = "." + ext
	}
	limit := 255 - len(utf16.Encode([]rune(suffix)))
	truncate := func(s string, units int) string {
		r := []rune(s)
		for len(utf16.Encode(r)) > units {
			r = r[:len(r)-1]
		}
		return string(r)
	}
	ext = truncate(ext, limit-1)
	base = truncate(base, limit-len(utf16.Encode([]rune(ext))))
	return base + suffix + ext
}

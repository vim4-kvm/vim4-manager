package nasdisk

import (
	"path"
	"sort"
	"strings"

	"github.com/vim4-kvm/vim4-manager/internal/i18n"
	"github.com/vim4-kvm/vim4-manager/internal/vfat"
)

// RecoveryPlan only imports identifiable files. A partial directory listing
// cannot establish that an original file was deleted, renamed or replaced by a
// directory. Existing files are guarded and copied to trash by the executor.
func RecoveryPlan(tree vfat.Tree, layout *vfat.Layout, result *vfat.Result) (*vfat.Plan, error) {
	if result == nil || result.Geometry != layout.Geometry {
		return nil, i18n.New("nasDisk.noFilesystem", nil)
	}
	original := map[string]vfat.Snapshot{}
	var walk func([]vfat.Node, string)
	walk = func(nodes []vfat.Node, parent string) {
		for _, n := range nodes {
			p := parent + "/" + n.Name
			original[p] = vfat.Snapshot{Path: p, Size: n.Size, Mtime: n.Mtime, SourceID: n.SourceID, Dir: n.Dir}
			walk(n.Children, p)
		}
	}
	walk(tree.Children, "")
	plan := &vfat.Plan{}
	nodes := append([]vfat.ParsedNode(nil), result.Nodes...)
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].Path < nodes[j].Path })
	for _, node := range nodes {
		if node.Path == "/" {
			continue
		}
		protected := false
		for _, part := range strings.Split(strings.TrimPrefix(node.Path, "/"), "/") {
			if part == PrivateName {
				protected = true
			}
			for _, pattern := range vfat.DefaultIgnorePatterns() {
				if ok, _ := path.Match(strings.ToLower(pattern), strings.ToLower(part)); ok {
					protected = true
				}
			}
		}
		for _, skip := range layout.Skipped {
			if node.Path == skip.Path || strings.HasPrefix(node.Path, skip.Path+"/") {
				protected = true
			}
		}
		if protected {
			plan.Summary.Ignored++
			continue
		}
		old, exists := original[node.Path]
		if node.Dir {
			if exists && !old.Dir {
				return nil, i18n.New("nasDisk.directoryConflict", map[string]any{"p0": node.Path})
			}
			if !exists {
				plan.Steps = append(plan.Steps, vfat.Step{Op: vfat.Mkdir, Path: node.Path, Mtime: node.Mtime})
				plan.AbsentPaths = append(plan.AbsentPaths, node.Path)
			}
			continue
		}
		if exists && old.Dir {
			return nil, i18n.New("nasDisk.fileConflict", map[string]any{"p0": node.Path})
		}
		step := vfat.Step{Op: vfat.Write, Path: node.Path, Mtime: node.Mtime, File: &node}
		if exists {
			step.Original = &old
			plan.Preconditions = append(plan.Preconditions, old)
		} else {
			plan.AbsentPaths = append(plan.AbsentPaths, node.Path)
		}
		plan.Steps = append(plan.Steps, step)
	}
	return plan, nil
}

package vfat

import (
	"fmt"
	"path"
	"sort"
	"strings"
	"testing"
	"time"
)

func hasStep(p *Plan, op Operation, name string) bool {
	for _, s := range p.Steps {
		if s.Op == op && s.Path == name {
			return true
		}
	}
	return false
}
func renameParsed(r *Result, from, to string) {
	for i := range r.Nodes {
		n := &r.Nodes[i]
		if under(n.Path, from) {
			n.Path = to + strings.TrimPrefix(n.Path, from)
			n.Name = path.Base(n.Path)
		}
	}
}
func deleteParsed(r *Result, p string) {
	var nodes []ParsedNode
	for _, n := range r.Nodes {
		if !under(n.Path, p) {
			nodes = append(nodes, n)
		}
	}
	r.Nodes = nodes
}
func changeParsed(r *Result, p string, size int64) {
	for i := range r.Nodes {
		if r.Nodes[i].Path == p {
			r.Nodes[i].Size = size
		}
	}
}

func assertPlanExecution(t *testing.T, tree Tree, l *Layout, final *Result, plan *Plan) {
	t.Helper()
	type state struct {
		dir  bool
		size int64
		id   SourceID
	}
	files := map[string]state{"/": {dir: true}}
	var add func([]Node, string)
	add = func(nodes []Node, parent string) {
		for _, n := range nodes {
			p := parent + "/" + n.Name
			files[p] = state{n.Dir, n.Size, n.SourceID}
			if n.Dir {
				add(n.Children, p)
			}
		}
	}
	add(tree.Children, "")
	for _, s := range plan.Steps {
		switch s.Op {
		case Mkdir:
			if _, ok := files[s.Path]; ok {
				t.Fatalf("mkdir destination occupied: %+v", s)
			}
			if !files[path.Dir(s.Path)].dir {
				t.Fatalf("mkdir parent absent: %+v", s)
			}
			files[s.Path] = state{dir: true}
		case Rename:
			obj, ok := files[s.From]
			if !ok {
				t.Fatalf("rename source absent: %+v", s)
			}
			if _, ok := files[s.Path]; ok {
				t.Fatalf("rename destination occupied: %+v", s)
			}
			if !files[path.Dir(s.Path)].dir {
				t.Fatalf("rename parent absent: %+v", s)
			}
			if under(s.Path, s.From) {
				t.Fatalf("rename into self: %+v", s)
			}
			moved := map[string]state{s.Path: obj}
			for p, value := range files {
				if under(p, s.From) {
					moved[s.Path+strings.TrimPrefix(p, s.From)] = value
					delete(files, p)
				}
			}
			for p, value := range moved {
				files[p] = value
			}
		case Write:
			if !files[path.Dir(s.Path)].dir || files[s.Path].dir {
				t.Fatalf("invalid write destination: %+v", s)
			}
			files[s.Path] = state{size: s.File.Size}
		case Delete, Rmdir:
			obj, ok := files[s.Path]
			if !ok || obj.dir != (s.Op == Rmdir) {
				t.Fatalf("delete source absent/wrong type: %+v", s)
			}
			for p := range files {
				if p != s.Path && under(p, s.Path) {
					t.Fatalf("rmdir has children: %+v child %s", s, p)
				}
			}
			delete(files, s.Path)
		case SetTime:
			if _, ok := files[s.Path]; !ok {
				t.Fatalf("set time target absent: %+v", s)
			}
		default:
			t.Fatalf("unknown operation %s", s.Op)
		}
	}
	want := map[string]bool{"/": true}
	for _, n := range final.Nodes {
		if ignored(n.Path, DefaultIgnorePatterns()) {
			continue
		}
		got, ok := files[n.Path]
		if !ok || got.dir != n.Dir || (!n.Dir && got.size != n.Size) {
			t.Fatalf("final %s: %+v expected %+v", n.Path, got, n)
		}
		want[n.Path] = true
	}
	for p := range files {
		if want[p] || ignored(p, DefaultIgnorePatterns()) {
			continue
		}
		skip := false
		for _, s := range l.Skipped {
			if under(p, s.Path) || under(s.Path, p) {
				skip = true
			}
		}
		if !skip {
			t.Fatalf("unexpected remaining path %s", p)
		}
	}
}

func TestPlanScenarios(t *testing.T) {
	for _, scenario := range []string{"unchanged", "content", "append", "truncate", "rename", "move", "directory-rename", "directory-child-change", "swap", "directory-swap", "delete", "nested-new", "ignored", "rename-over-deleted", "replace-directory", "replace-file-with-directory", "mtime"} {
		t.Run(scenario, func(t *testing.T) {
			tree, l, v := fixture(t)
			out := parseOK(t, v)
			var dirty []ClusterRange
			switch scenario {
			case "unchanged":
			case "content":
				dirty = entryAt(t, l, "/alpha.txt").Chain
			case "append":
				changeParsed(out, "/alpha.txt", 9000)
			case "truncate":
				changeParsed(out, "/alpha.txt", 1)
			case "rename":
				renameParsed(out, "/alpha.txt", "/renamed.txt")
			case "move":
				renameParsed(out, "/alpha.txt", "/folder/alpha.txt")
			case "directory-rename":
				renameParsed(out, "/folder", "/renamed")
			case "directory-child-change":
				renameParsed(out, "/folder", "/renamed")
				renameParsed(out, "/renamed/lower.UPP", "/renamed/new.txt")
				out.Nodes = append(out.Nodes, ParsedNode{Path: "/renamed/newdir", Name: "newdir", Dir: true, FirstCluster: 900, Mtime: testTime}, ParsedNode{Path: "/renamed/newdir/file", Name: "file", Size: 1, FirstCluster: 901, Chain: []ClusterRange{{901, 901}}, Mtime: testTime})
			case "swap":
				renameParsed(out, "/alpha.txt", "/tmp")
				renameParsed(out, "/MixedCase.TXT", "/alpha.txt")
				renameParsed(out, "/tmp", "/MixedCase.TXT")
			case "directory-swap":
				renameParsed(out, "/folder", "/new")
				out.Nodes = append(out.Nodes, ParsedNode{Path: "/folder", Name: "folder", Dir: true, FirstCluster: 900, Mtime: testTime})
			case "delete":
				deleteParsed(out, "/folder")
				deleteParsed(out, "/alpha.txt")
			case "nested-new":
				out.Nodes = append(out.Nodes, ParsedNode{Path: "/new", Name: "new", Dir: true, FirstCluster: 900, Mtime: testTime}, ParsedNode{Path: "/new/child", Name: "child", Dir: true, FirstCluster: 901, Mtime: testTime}, ParsedNode{Path: "/new/child/file", Name: "file", Size: 5, FirstCluster: 902, Chain: []ClusterRange{{902, 902}}, Mtime: testTime})
			case "ignored":
				out.Nodes = append(out.Nodes, ParsedNode{Path: "/.DS_Store", Name: ".DS_Store", Size: 5, FirstCluster: 900, Chain: []ClusterRange{{900, 900}}, Mtime: testTime})
			case "rename-over-deleted":
				deleteParsed(out, "/MixedCase.TXT")
				renameParsed(out, "/alpha.txt", "/MixedCase.TXT")
			case "replace-directory":
				deleteParsed(out, "/folder")
				renameParsed(out, "/alpha.txt", "/folder")
			case "replace-file-with-directory":
				deleteParsed(out, "/alpha.txt")
				renameParsed(out, "/folder", "/alpha.txt")
			case "mtime":
				for i := range out.Nodes {
					if out.Nodes[i].Path == "/alpha.txt" {
						out.Nodes[i].Mtime = testTime.Add(time.Hour)
					}
				}
			}
			plan, err := BuildPlan(tree, l, out, dirty, PlanOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "unchanged" && len(plan.Steps) != 0 {
				t.Fatal(plan.Steps)
			}
			if scenario == "content" && !hasStep(plan, Write, "/alpha.txt") {
				t.Fatal("dirty content not written")
			}
			if scenario == "directory-rename" {
				if plan.Summary.Renamed != 1 {
					t.Fatal("expanded directory move", plan.Summary)
				}
			}
			if scenario == "swap" && plan.Summary.Renamed != 2 {
				t.Fatal(plan.Summary)
			}
			if scenario == "mtime" && !hasStep(plan, SetTime, "/alpha.txt") {
				t.Fatal("time lost")
			}
			assertPlanExecution(t, tree, l, out, plan)
			second, err := BuildPlan(tree, l, out, dirty, PlanOptions{})
			if err != nil || fmt.Sprint(second) != fmt.Sprint(plan) { // Compare values separately; pointers are intentionally fresh.
				if err != nil {
					t.Fatal(err)
				}
				for i := range plan.Steps {
					a, b := plan.Steps[i], second.Steps[i]
					if a.Op != b.Op || a.Path != b.Path || a.From != b.From {
						t.Fatal("unstable order")
					}
				}
			}
		})
	}
}

func TestPlanSkippedIgnoredAndConflicts(t *testing.T) {
	tree := Tree{[]Node{{Name: "big", Size: 1 << 32}, {Name: ".DS_Store", Size: 3, SourceID: "meta"}, {Name: "folder", Dir: true, Children: []Node{{Name: "huge", Size: 1 << 32}, {Name: "small", Size: 1, SourceID: "small"}}}}}
	l, err := Build(tree, Options{})
	if err != nil {
		t.Fatal(err)
	}
	v := NewVolume(l, testSource{"meta": []byte("123"), "small": []byte("s")})
	out := parseOK(t, v)
	deleteParsed(out, "/.DS_Store")
	deleteParsed(out, "/folder")
	plan, err := BuildPlan(tree, l, out, nil, PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range plan.Steps {
		if s.Path != "/folder/small" {
			t.Fatalf("protected source changed: %+v", s)
		}
	}
	if plan.Summary.PendingConflicts != 1 || plan.Preconditions[0].SourceID != "small" {
		t.Fatal(plan)
	}
	if got := ConflictName("hello.txt", testTime); got != "hello (conflict 20261017-123456).txt" {
		t.Fatal(got)
	}
	out.Safe = false
	if _, err := BuildPlan(tree, l, out, nil, PlanOptions{}); err == nil {
		t.Fatal("unsafe plan")
	}
}

func TestPlanDirectorySwapWithChildEscape(t *testing.T) {
	tree := Tree{[]Node{{Name: "a", Dir: true, Mtime: testTime, Children: []Node{{Name: "one", Size: 1, SourceID: "one", Mtime: testTime}, {Name: "gone", Size: 1, SourceID: "gone", Mtime: testTime}}}, {Name: "b", Dir: true, Mtime: testTime, Children: []Node{{Name: "two", Size: 1, SourceID: "two", Mtime: testTime}}}}}
	l, err := Build(tree, Options{})
	if err != nil {
		t.Fatal(err)
	}
	out := parseOK(t, NewVolume(l, testSource{"one": []byte{1}, "two": []byte{2}, "gone": []byte{3}}))
	renameParsed(out, "/a", "/tmp")
	renameParsed(out, "/b", "/a")
	renameParsed(out, "/tmp", "/b")
	renameParsed(out, "/b/one", "/a/one")
	deleteParsed(out, "/b/gone")
	plan, err := BuildPlan(tree, l, out, nil, PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	assertPlanExecution(t, tree, l, out, plan)
	if plan.Summary.Renamed != 3 {
		t.Fatal(plan.Summary)
	}
	if !sort.StringsAreSorted(plan.AbsentPaths) {
		t.Fatal("unstable preconditions")
	}
}

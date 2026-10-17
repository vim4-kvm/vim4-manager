package vfat

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func TestDirectoryEntryAndAllocationLimits(t *testing.T) {
	var nodes []Node
	for i := 0; i < 65540; i++ {
		nodes = append(nodes, Node{Name: fmt.Sprintf("%08d", i)})
	}
	l, err := Build(Tree{nodes}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if len(l.Skipped) == 0 || len(l.Entries)+len(l.Skipped) != len(nodes)+1 {
		t.Fatal("entry overflow silently lost")
	}
	for _, s := range l.Skipped {
		if s.Reason != "directory entry limit" {
			t.Fatal(s)
		}
	}
	if _, err := Build(Tree{}, Options{Size: 1 << 41}); err == nil {
		t.Fatal("accepted unrepresentable sector count")
	}
	if _, err := Build(Tree{}, Options{ClusterSize: 1023}); err == nil {
		t.Fatal("accepted invalid cluster size")
	}
	// Metadata overhead crosses the automatic cluster-size table boundary.
	l, err = Build(Tree{}, Options{WritableBytes: 260 << 20})
	if err != nil {
		t.Fatal(err)
	}
	if l.Geometry.ClusterSize != RecommendedClusterSize(l.Geometry.Size) {
		t.Fatal(l.Geometry)
	}
}

func TestReaderLFNFallbackAndLimits(t *testing.T) {
	_, l, v := fixture(t)
	o := NewMemoryOverlay(v)
	defer o.Close()
	// Root starts with a volume label, then MixedCase.TXT's single LFN.
	writeAt(t, o, []byte{0}, l.Geometry.ClusterOffset(2)+32+13)
	r := parseOK(t, o)
	nodeAt(t, r, "/MIXEDC~1.TXT")
	for _, opts := range []ReaderOptions{{MaxEntries: 1}, {MaxClusters: 1}, {MaxDirectoryBytes: 512}} {
		r, err := Parse(context.Background(), v, opts)
		if err == nil || r.Safe {
			t.Fatal("reader resource bound not enforced")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Parse(ctx, v, ReaderOptions{}); err == nil {
		t.Fatal("ignored cancellation")
	}
	short := packShort(string([]byte{0xe5})+"FILE", "TXT")
	if short[0] != 5 {
		t.Fatal("0xe5 not escaped")
	}
	e := shortEntry(short, 0, 32, 0, 0, testTime)
	if decodeShort(e) != "σFILE.TXT" {
		t.Fatal(decodeShort(e))
	}
}

func TestOverlayConcurrentPartialWritesAndCorruption(t *testing.T) {
	_, l, v := fixture(t)
	o := NewMemoryOverlay(v)
	defer o.Close()
	off := (l.Geometry.DataOffset() + 4095) / 4096 * 4096
	want := make([]byte, 4096)
	if _, err := v.ReadAt(want, off); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		copy(want[i*16:], bytes.Repeat([]byte{byte(i)}, 16))
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if _, err := o.WriteAt(bytes.Repeat([]byte{byte(i)}, 16), off+int64(i*16)); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	got := make([]byte, 4096)
	if _, err := o.ReadAt(got, off); err != nil || !bytes.Equal(got, want) {
		t.Fatal("lost concurrent partial update", err)
	}
	p := filepath.Join(t.TempDir(), "overlay")
	disk, err := OpenFileOverlay(v, p)
	if err != nil {
		t.Fatal(err)
	}
	writeAt(t, disk, []byte{123}, off)
	disk.Close()
	f, err := os.OpenFile(p, os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	writeAt(t, f, []byte{124}, off)
	f.Close()
	if reopened, err := OpenFileOverlay(v, p); err == nil {
		reopened.Close()
		t.Fatal("accepted corrupt overlay data")
	}
}

func TestPlanSingleClaimAndSkippedCollision(t *testing.T) {
	tree, l, v := fixture(t)
	r := parseOK(t, v)
	n := nodeAt(t, r, "/alpha.txt")
	n.Path = "/copy.txt"
	n.Name = "copy.txt"
	r.Nodes = append(r.Nodes, n)
	plan, err := BuildPlan(tree, l, r, nil, PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !hasStep(plan, Write, "/copy.txt") || plan.Summary.Renamed != 0 {
		t.Fatal("double claimed source", plan)
	}
	for i := 0; i < 10; i++ {
		next, err := BuildPlan(tree, l, r, nil, PlanOptions{})
		if err != nil || !reflect.DeepEqual(plan, next) {
			t.Fatal("nondeterministic plan", err)
		}
	}
	bigTree := Tree{[]Node{{Name: "big", Size: 1 << 32}}}
	layout, err := Build(bigTree, Options{})
	if err != nil {
		t.Fatal(err)
	}
	result := parseOK(t, NewVolume(layout, nil))
	result.Nodes = append(result.Nodes, ParsedNode{Path: "/big", Name: "big"})
	if _, err := BuildPlan(bigTree, layout, result, nil, PlanOptions{}); err == nil {
		t.Fatal("overwrote skipped original")
	}
	for _, name := range []string{strings.Repeat("a", 255), strings.Repeat("😀", 120) + ".txt", "x." + strings.Repeat("e", 250)} {
		if got := ConflictName(name, testTime); !validName(got) {
			t.Fatalf("invalid conflict name %q", got)
		}
	}
}

func TestSourceShortReadIsAnError(t *testing.T) {
	l, err := Build(Tree{[]Node{{Name: "file", Size: 100, SourceID: "x"}}}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	v := NewVolume(l, testSource{"x": []byte{1}})
	if _, err := v.ReadAt(make([]byte, 100), l.Geometry.ClusterOffset(3)); err != io.EOF {
		t.Fatalf("source shrink not reported: %v", err)
	}
}

func TestIgnoredSummaryCountsEachPathOnce(t *testing.T) {
	tree := Tree{[]Node{{Name: ".DS_Store"}, {Name: "big", Size: 1 << 32}}}
	l, err := Build(tree, Options{})
	if err != nil {
		t.Fatal(err)
	}
	r := parseOK(t, NewVolume(l, nil))
	p, err := BuildPlan(tree, l, r, nil, PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Steps) != 0 || p.Summary.Ignored != 2 {
		t.Fatal(p)
	}
}

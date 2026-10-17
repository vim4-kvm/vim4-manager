package vfat

import (
	"bytes"
	"fmt"
	"reflect"
	"testing"
)

func TestAlignedGeometryBoundaries(t *testing.T) {
	for _, cs := range []int{4096, 8192, 16384, 32768} {
		for _, size := range []int64{0, 1, 64 << 30, int64(maxSectors * 512)} {
			t.Run(fmt.Sprintf("%d/%d", cs, size), func(t *testing.T) {
				l, err := Build(Tree{}, Options{Size: size, ClusterSize: cs})
				if cs == 4096 && size == int64(maxSectors*512) {
					if err == nil {
						t.Fatal("accepted more than FAT32's maximum cluster count")
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				g := l.Geometry
				if g.DataOffset()%4096 != 0 || g.DataOffset()%int64(cs) != 0 || g.ReservedSectors*512%4096 != 0 || g.FATSectors*512%4096 != 0 {
					t.Fatalf("unaligned geometry: %+v", g)
				}
				if g.Size > int64(maxSectors*512) || g.Clusters < 65525 || uint64(g.FATSectors)*128 < uint64(g.Clusters)+2 || g.ClusterOffset(g.Clusters+2) > g.Size {
					t.Fatalf("invalid geometry: %+v", g)
				}
				if size == 0 {
					volume := NewVolume(l, nil)
					parsed := parseOK(t, volume)
					if parsed.Geometry != g {
						t.Fatalf("BPB geometry mismatch: %+v", parsed.Geometry)
					}
					if g.ReservedSectors > 32 {
						padding := make([]byte, (g.ReservedSectors-32)*512)
						if _, err := volume.ReadAt(padding, 32*512); err != nil {
							t.Fatal(err)
						}
						if !bytes.Equal(padding, make([]byte, len(padding))) {
							t.Fatal("reserved padding contains FAT data")
						}
					}
				}
			})
		}
		// FAT capacity changes in 1024-cluster increments. Verify both sizing
		// modes around that boundary, including the minimum FAT32 cluster count.
		for _, count := range []int64{65525, 65534, 65535, 65536, 66558, 66559} {
			l, err := Build(Tree{}, Options{ClusterSize: cs, WritableBytes: (count - 1) * int64(cs)})
			if err != nil {
				t.Fatal(err)
			}
			if int64(l.Geometry.Clusters) < count {
				t.Fatal(l.Geometry)
			}
			explicit, err := Build(Tree{}, Options{ClusterSize: cs, Size: l.Geometry.Size})
			if err != nil || explicit.Geometry != l.Geometry {
				t.Fatalf("sizing modes differ: %v", err)
			}
		}
	}
	for _, opts := range []Options{{LayoutVersion: 99}, {ClusterSize: 512}, {ClusterSize: 2048}} {
		if _, err := Build(Tree{}, opts); err == nil {
			t.Fatalf("accepted %+v", opts)
		}
	}
}

func TestAlignedOverlayKeepsNeighborFilesClean(t *testing.T) {
	for _, cs := range []int{4096, 32768} {
		t.Run(fmt.Sprint(cs), func(t *testing.T) {
			source := testSource{"a": make([]byte, 2*cs), "old": []byte("old"), "edit": []byte("edit")}
			tree := Tree{[]Node{
				{Name: "a.bin", Size: int64(2 * cs), SourceID: "a"},
				{Name: "docs", Dir: true, Children: []Node{
					{Name: "old.txt", Size: 3, SourceID: "old"},
					{Name: "z.txt", Size: 4, SourceID: "edit"},
				}},
			}}
			l, err := Build(tree, Options{Size: 64 << 30, ClusterSize: cs, Time: testTime})
			if err != nil {
				t.Fatal(err)
			}
			o := NewMemoryOverlay(NewVolume(l, source))
			defer o.Close()
			dir := entryAt(t, l, "/docs")
			file := entryAt(t, l, "/a.bin")
			if file.Chain[0].End+1 != dir.FirstCluster {
				t.Fatal("fixture must have adjacent file and directory")
			}
			// Rename within the directory, touching only its first cluster.
			off := dirEntryOffset(t, o, l.Geometry, dir.FirstCluster, "old.txt")
			short := packShort("NEW", "TXT")
			writeAt(t, o, short[:], off)
			if got := o.DirtyClusters(); !reflect.DeepEqual(got, []ClusterRange{{dir.FirstCluster, dir.FirstCluster}}) {
				t.Fatalf("directory write dirtied a neighbor: %v", got)
			}
			plan, err := BuildPlan(tree, l, parseOK(t, o), o.DirtyClusters(), PlanOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if hasStep(plan, Write, "/a.bin") || !hasStep(plan, Rename, "/docs/new.txt") {
				t.Fatalf("unexpected plan: %+v", plan)
			}
			// The renamed file ends immediately before the in-place edit.
			old := entryAt(t, l, "/docs/old.txt")
			edit := entryAt(t, l, "/docs/z.txt")
			if old.Chain[0].End+1 != edit.FirstCluster {
				t.Fatal("fixture files must be adjacent")
			}
			writeAt(t, o, []byte("EDIT"), l.Geometry.ClusterOffset(edit.FirstCluster))
			if got := o.DirtyClusters(); !reflect.DeepEqual(got, []ClusterRange{{dir.FirstCluster, dir.FirstCluster}, {edit.FirstCluster, edit.FirstCluster}}) {
				t.Fatalf("in-place edit dirtied renamed file: %v", got)
			}
			plan, err = BuildPlan(tree, l, parseOK(t, o), o.DirtyClusters(), PlanOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if plan.Summary.Modified != 1 || plan.Summary.Renamed != 1 || plan.Summary.Deleted != 0 || !hasStep(plan, Write, "/docs/z.txt") || !hasStep(plan, Rename, "/docs/new.txt") {
				t.Fatalf("edit lost neighboring rename: %+v", plan)
			}
		})
	}
}

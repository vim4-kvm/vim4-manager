package vfat

import (
	"context"
	"testing"
	"time"
)

func TestFixedOffsetDirectoryTimesAndHostWrite(t *testing.T) {
	mtime := time.Date(2026, 10, 17, 18, 34, 56, 0, time.UTC)
	tree := Tree{Children: []Node{{Name: "file", Size: 0, Mtime: mtime, SourceID: "file"}}}
	for _, offset := range []int{-720, -210, 0, 480, 840} {
		layout, err := Build(tree, Options{UTCOffsetMinutes: offset})
		if err != nil {
			t.Fatal(err)
		}
		location := time.FixedZone("host", offset*60)
		entry := layout.Entries[0].directory[32:64]
		wallTime := decodeTime(le.Uint16(entry[24:]), le.Uint16(entry[22:]), time.UTC)
		if wallTime.Format("2006-01-02 15:04:05") != mtime.In(location).Format("2006-01-02 15:04:05") {
			t.Fatalf("offset %d: directory time %s, NAS time %s", offset, wallTime, mtime.In(location))
		}
		overlay := NewMemoryOverlay(NewVolume(layout, nil))
		defer overlay.Close()
		result, err := Parse(context.Background(), overlay, ReaderOptions{UTCOffsetMinutes: offset})
		if err != nil {
			t.Fatal(err)
		}
		if !nodeAt(t, result, "/file").Mtime.Equal(mtime) {
			t.Fatalf("offset %d did not round trip", offset)
		}
		plan, err := BuildPlan(tree, layout, result, nil, PlanOptions{})
		if err != nil || len(plan.Steps) != 0 {
			t.Fatalf("unchanged volume scheduled mutations: %+v %v", plan, err)
		}
		hostLocal := time.Date(2026, 10, 19, 1, 2, 4, 0, location)
		date, clock := fatTime(hostLocal, location)
		updated := append([]byte(nil), entry...)
		le.PutUint16(updated[22:], clock)
		le.PutUint16(updated[24:], date)
		if _, err := overlay.WriteAt(updated, layout.Geometry.ClusterOffset(layout.Geometry.RootCluster)+32); err != nil {
			t.Fatal(err)
		}
		result, err = Parse(context.Background(), overlay, ReaderOptions{UTCOffsetMinutes: offset})
		if err != nil {
			t.Fatal(err)
		}
		got := nodeAt(t, result, "/file").Mtime
		if !got.Equal(hostLocal.UTC()) || got.Location() != time.UTC {
			t.Fatalf("offset %d: host time parsed as %s, want %s", offset, got, hostLocal.UTC())
		}
	}
}

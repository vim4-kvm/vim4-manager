package vfat

import (
	"fmt"
	"testing"
)

func TestLegacyLayoutFingerprint(t *testing.T) {
	tree := Tree{[]Node{{Name: "file", Size: 7000, SourceID: "file", Mtime: testTime}}}
	// Fingerprints captured from the pre-alignment implementation. Overlay
	// headers bind this ID, so a merely equivalent layout is insufficient.
	for _, test := range []struct {
		size     int64
		geometry Geometry
		id       string
	}{
		{0, Geometry{34089472, 512, 32, 512, 2, 65525, 2}, "f14d7f45c994c75cb35c692323f9d7f82089ad09be4232a81cb5f781ede47ea4"},
		{64 << 30, Geometry{68719476736, 32768, 32, 16381, 2, 2096639, 2}, "168044ed6753460423d4bc5c9471fcf5ebbcabc249c1604d64dd74501cc2aef5"},
		{int64(maxSectors * 512), Geometry{2199023255040, 32768, 32, 524161, 2, 67092483, 2}, "f3e9b11155562d25badacf6253130f5fc2b47e7291bf2c6c8c4239ba28ef15e1"},
	} {
		l, err := Build(tree, Options{LayoutVersion: LayoutLegacy, Size: test.size, Time: testTime, WritableBytes: 1 << 20})
		if err != nil {
			t.Fatal(err)
		}
		if l.Geometry != test.geometry || fmt.Sprintf("%x", l.ID) != test.id {
			t.Fatalf("legacy layout changed: %+v ID %x", l.Geometry, l.ID)
		}
	}
}

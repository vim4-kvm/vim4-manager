package vfat

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

var testTime = time.Date(2026, 10, 17, 12, 34, 56, 0, time.UTC)

type testSource map[SourceID][]byte

func (s testSource) ReadAt(id SourceID, p []byte, off int64) (int, error) {
	return bytes.NewReader(s[id]).ReadAt(p, off)
}

func fixture(t *testing.T) (Tree, *Layout, *Volume) {
	t.Helper()
	source := testSource{"a": bytes.Repeat([]byte("abcdefg"), 1000), "b": []byte("中文内容\n"), "c": []byte("hello"), "d": []byte("end")}
	tree := Tree{[]Node{{Name: "alpha.txt", Size: int64(len(source["a"])), Mtime: testTime, SourceID: "a"}, {Name: "中文 长名字.txt", Size: int64(len(source["b"])), Mtime: testTime, SourceID: "b"}, {Name: "MixedCase.TXT", Size: 5, Mtime: testTime, SourceID: "c"}, {Name: "empty", Mtime: testTime}, {Name: "folder", Dir: true, Mtime: testTime, Children: []Node{{Name: "lower.UPP", Size: 3, Mtime: testTime, SourceID: "d"}}}}}
	l, err := Build(tree, Options{Time: testTime, WritableBytes: 1 << 20})
	if err != nil {
		t.Fatal(err)
	}
	return tree, l, NewVolume(l, source)
}
func parseOK(t *testing.T, r io.ReaderAt) *Result {
	t.Helper()
	out, err := Parse(context.Background(), r, ReaderOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !out.Safe {
		t.Fatal("unsafe parse")
	}
	return out
}
func nodeAt(t *testing.T, r *Result, p string) ParsedNode {
	t.Helper()
	for _, n := range r.Nodes {
		if n.Path == p {
			return n
		}
	}
	t.Fatalf("missing %s", p)
	return ParsedNode{}
}
func entryAt(t *testing.T, l *Layout, p string) *Entry {
	t.Helper()
	for _, e := range l.Entries {
		if e.Path == p {
			return e
		}
	}
	t.Fatalf("missing %s", p)
	return nil
}
func writeAt(t *testing.T, w io.WriterAt, p []byte, off int64) {
	t.Helper()
	if n, err := w.WriteAt(p, off); err != nil || n != len(p) {
		t.Fatalf("write: %d %v", n, err)
	}
}
func setFAT(t *testing.T, o io.WriterAt, g Geometry, c, next uint32) {
	t.Helper()
	var b [4]byte
	le.PutUint32(b[:], next)
	for i := uint32(0); i < g.FATs; i++ {
		writeAt(t, o, b[:], int64(g.ReservedSectors+i*g.FATSectors)*512+int64(c)*4)
	}
}
func dirEntryOffset(t *testing.T, v io.ReaderAt, g Geometry, dir uint32, name string) int64 {
	t.Helper()
	b := make([]byte, g.ClusterSize)
	if _, err := v.ReadAt(b, g.ClusterOffset(dir)); err != nil {
		t.Fatal(err)
	}
	for off := 0; off+32 <= len(b); off += 32 {
		if b[off+11] != 15 && decodeShort(b[off:off+32]) == name {
			return g.ClusterOffset(dir) + int64(off)
		}
	}
	t.Fatalf("directory entry %s missing", name)
	return 0
}

func TestNamesAndTimes(t *testing.T) {
	for _, test := range []struct {
		name  string
		flags byte
		long  bool
	}{{"lower.txt", 24, false}, {"UPPER.txt", 16, false}, {"lower.TXT", 8, false}, {"Mixed.txt", 0, true}, {"中文.txt", 0, true}, {"has space.txt", 0, true}, {"12345678.abc", 16, false}} {
		s, f, l := makeShort(test.name, map[[11]byte]bool{})
		if f != test.flags || l != test.long {
			t.Errorf("%s: %q %x %v", test.name, s, f, l)
		}
		e := shortEntry(s, f, 32, 3, 1, testTime)
		if l {
			state := lfnState{}
			b := longEntries(test.name, s)
			for off := 0; off < len(b); off += 32 {
				state.add(b[off : off+32])
			}
			got, ok := state.name(e)
			if !ok || got != test.name {
				t.Fatalf("LFN %q %v", got, ok)
			}
			e[0]++
			if _, ok := state.name(e); ok {
				t.Fatal("accepted mismatched checksum")
			}
		} else if decodeShort(e) != test.name {
			t.Fatal("case flags lost")
		}
	}
	used := map[[11]byte]bool{packShort("LONGFI~1", "TXT"): true}
	a, _, _ := makeShort("long filename.txt", used)
	b, _, _ := makeShort("long filename two.txt", used)
	if a == b || string(a[:8]) != "LONGFI~2" {
		t.Fatalf("aliases: %q %q", a, b)
	}
	for _, length := range []int{13, 26, 255} {
		name := strings.Repeat("x", length)
		s := packShort("XXXX~1", "")
		raw := longEntries(name, s)
		state := lfnState{}
		for i := 0; i < len(raw); i += 32 {
			state.add(raw[i : i+32])
		}
		if got, ok := state.name(shortEntry(s, 0, 32, 0, 0, testTime)); !ok || got != name {
			t.Fatalf("LFN length %d", length)
		}
	}
	for _, at := range []time.Time{testTime.Add(time.Second), time.Date(1970, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2200, 1, 1, 0, 0, 0, 0, time.UTC)} {
		d, c := fatTime(at)
		got := decodeTime(d, c)
		if got.Year() < 1980 || got.Year() > 2107 || got.Second()%2 != 0 {
			t.Fatal(got)
		}
	}
	if a, b := fatTime(testTime.In(time.FixedZone("offset", 3600))); func() bool { c, d := fatTime(testTime); return a == c && b == d }() == false {
		t.Fatal("not UTC")
	}
}

func TestGeometryAndFAT(t *testing.T) {
	for _, test := range []struct {
		size    int64
		cluster int
	}{{1, 512}, {260 << 20, 512}, {261 << 20, 4096}, {8 << 30, 4096}, {9 << 30, 8192}, {17 << 30, 16384}, {33 << 30, 32768}} {
		if got := RecommendedClusterSize(test.size); got != test.cluster {
			t.Fatalf("size %d: %d", test.size, got)
		}
	}
	for _, size := range []int64{0, 1, 64 << 20, 500 << 30, int64(maxSectors * 512)} {
		l, err := Build(Tree{}, Options{Size: size})
		if err != nil {
			t.Fatal(size, err)
		}
		g := l.Geometry
		if g.Clusters < 65525 || int64(g.FATSectors)*512 < int64(g.Clusters+2)*4 {
			t.Fatal(g)
		}
		if len(l.intervals) != 1 {
			t.Fatal("materialized FAT")
		}
		var b [1024]byte
		if _, err := NewVolume(l, nil).ReadAt(b[:], int64(g.ReservedSectors)*512); err != nil {
			t.Fatal(err)
		}
		if le.Uint32(b[:]) != 0x0ffffff8 || le.Uint32(b[4:]) != 0x0fffffff || le.Uint32(b[8:]) != 0x0fffffff {
			t.Fatal("reserved FAT entries")
		}
	}
	tree := Tree{[]Node{{Name: "large", Size: 130 * 512, SourceID: "x"}}}
	l, err := Build(tree, Options{})
	if err != nil {
		t.Fatal(err)
	}
	for c := uint32(3); c < 133; c++ {
		want := c + 1
		if c == 132 {
			want = 0x0fffffff
		}
		if l.fatEntry(c) != want {
			t.Fatalf("FAT[%d]=%x want %x", c, l.fatEntry(c), want)
		}
	}
	var b [12]byte
	_, err = NewVolume(l, nil).ReadAt(b[:], 32*512+126*4)
	if err != nil || le.Uint32(b[8:]) != 129 {
		t.Fatalf("cross FAT sector: %x %v", b, err)
	}
}

func TestRoundTripAndReadSlices(t *testing.T) {
	_, l, v := fixture(t)
	out := parseOK(t, v)
	if len(out.Nodes) != len(l.Entries) {
		t.Fatal("tree length")
	}
	for _, e := range l.Entries {
		n := nodeAt(t, out, e.Path)
		if n.Dir != e.Node.Dir || n.Size != e.Node.Size || !slices.Equal(n.Chain, e.Chain) || (e.Path != "/" && !sameFATTime(n.Mtime, e.Node.Mtime)) {
			t.Fatalf("round trip %s: %+v", e.Path, n)
		}
		if !n.Dir {
			got := make([]byte, n.Size)
			if _, err := out.ReadFileAt(n, got, 0); err != nil {
				t.Fatal(err)
			}
			if e.Node.Size > 0 && !bytes.Equal(got, v.source.(testSource)[e.Node.SourceID]) {
				t.Fatal("file content")
			}
		}
	}
	material := make([]byte, l.Geometry.Size)
	if _, err := io.ReadFull(io.NewSectionReader(v, 0, l.Geometry.Size), material); err != nil {
		t.Fatal(err)
	}
	rng := rand.New(rand.NewSource(1))
	for i := 0; i < 2000; i++ {
		off := rng.Int63n(l.Geometry.Size)
		size := rng.Intn(8192)
		if int64(size) > l.Geometry.Size-off {
			size = int(l.Geometry.Size - off)
		}
		got := make([]byte, size)
		if _, err := v.ReadAt(got, off); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, material[off:off+int64(size)]) {
			t.Fatalf("slice off=%d size=%d", off, size)
		}
	}
	// A second traversal with non-sector chunk boundaries compares every byte.
	buf := make([]byte, 7919)
	for off := int64(0); off < l.Geometry.Size; off += int64(len(buf)) {
		n, err := v.ReadAt(buf, off)
		if err != nil && err != io.EOF {
			t.Fatal(err)
		}
		if !bytes.Equal(buf[:n], material[off:off+int64(n)]) {
			t.Fatalf("stream mismatch %d", off)
		}
	}
	if n, err := v.ReadAt(make([]byte, 5), l.Geometry.Size-2); n != 2 || err != io.EOF {
		t.Fatalf("end %d %v", n, err)
	}
}

func TestSkippedAndScan(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".vim4-nasdisk"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "ok"), []byte("a"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("ok", filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	tree, err := Scan(context.Background(), root, ScanOptions{ExcludeName: ".vim4-nasdisk"})
	if err != nil {
		t.Fatal(err)
	}
	if len(tree.Children) != 2 {
		t.Fatal(tree)
	}
	l, err := Build(tree, Options{})
	if err != nil || len(l.Skipped) != 1 {
		t.Fatalf("%v %v", l, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Scan(ctx, root, ScanOptions{}); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := Scan(context.Background(), root, ScanOptions{MaxEntries: 1}); err == nil {
		t.Fatal("entry bound")
	}
	tree.Children = append(tree.Children, Node{Name: "bad?"}, Node{Name: "big", Size: 1 << 32}, Node{Name: "OK"}, Node{Name: strings.Repeat("😀", 128)}, Node{Name: "pipe", Mode: fs.ModeNamedPipe}, Node{Name: "dir", Dir: true, Children: []Node{{Name: "deep"}}})
	l, err = Build(tree, Options{MaxDepth: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(l.Skipped) != 7 {
		t.Fatalf("skipped: %+v", l.Skipped)
	}
	if _, err := Build(tree, Options{MaxDirectoryBytes: 512}); err == nil {
		t.Fatal("directory bound")
	}
}

func TestOverlayPersistence(t *testing.T) {
	_, l, v := fixture(t)
	for _, disk := range []bool{false, true} {
		t.Run(fmt.Sprint(disk), func(t *testing.T) {
			var o Overlay
			var err error
			file := filepath.Join(t.TempDir(), "overlay")
			if disk {
				o, err = OpenFileOverlay(v, file)
			} else {
				o = NewMemoryOverlay(v)
			}
			if err != nil {
				t.Fatal(err)
			}
			base := make([]byte, 8200)
			off := l.Geometry.ClusterOffset(3) - 7
			if _, err := v.ReadAt(base, off); err != nil {
				t.Fatal(err)
			}
			want := append([]byte(nil), base...)
			copy(want[3:], []byte("changed"))
			writeAt(t, o, []byte("changed"), off+3)
			copy(want[4090:], bytes.Repeat([]byte{42}, 25))
			writeAt(t, o, bytes.Repeat([]byte{42}, 25), off+4090)
			copy(want[4:], []byte("again"))
			writeAt(t, o, []byte("again"), off+4)
			before := o.DirtyClusters()
			if len(before) == 0 {
				t.Fatal("dirty set empty")
			}
			if disk {
				if err := o.Close(); err != nil {
					t.Fatal(err)
				}
				o, err = OpenFileOverlay(v, file)
				if err != nil {
					t.Fatal(err)
				}
			}
			got := make([]byte, len(want))
			if _, err := o.ReadAt(got, off); err != nil || !bytes.Equal(got, want) {
				t.Fatalf("RMW: %v", err)
			}
			if !reflect.DeepEqual(before, o.DirtyClusters()) {
				t.Fatal("lost dirty set")
			}
			if _, err := o.WriteAt([]byte{1}, l.Geometry.Size); err == nil {
				t.Fatal("accepted out of bounds")
			}
			if err := o.Close(); err != nil {
				t.Fatal(err)
			}
			if disk {
				f, err := os.OpenFile(file+".index", os.O_APPEND|os.O_WRONLY, 0600)
				if err != nil {
					t.Fatal(err)
				}
				f.Write([]byte{1, 2, 3})
				f.Close()
				o, err = OpenFileOverlay(v, file)
				if err != nil {
					t.Fatal("torn tail", err)
				}
				o.Close()
				other, _ := Build(Tree{}, Options{})
				if _, err := OpenFileOverlay(NewVolume(other, nil), file); err == nil {
					t.Fatal("accepted wrong snapshot")
				}
			}
		})
	}
}

func TestReaderRejectsCorruption(t *testing.T) {
	_, l, v := fixture(t)
	a := entryAt(t, l, "/alpha.txt")
	b := entryAt(t, l, "/MixedCase.TXT")
	for _, name := range []string{"loop", "cross-link", "outside", "short-chain", "long-chain", "root", "dot", "truncated"} {
		t.Run(name, func(t *testing.T) {
			o := NewMemoryOverlay(v)
			defer o.Close()
			switch name {
			case "loop":
				setFAT(t, o, l.Geometry, a.Chain[0].End, a.FirstCluster)
			case "cross-link":
				setFAT(t, o, l.Geometry, a.FirstCluster, b.FirstCluster)
			case "outside":
				setFAT(t, o, l.Geometry, a.FirstCluster, l.Geometry.Clusters+2)
			case "short-chain":
				setFAT(t, o, l.Geometry, a.FirstCluster, 0x0fffffff)
			case "long-chain":
				setFAT(t, o, l.Geometry, b.FirstCluster, a.FirstCluster)
			case "root":
				setFAT(t, o, l.Geometry, 2, 0)
			case "dot":
				d := entryAt(t, l, "/folder")
				writeAt(t, o, []byte{0}, l.Geometry.ClusterOffset(d.FirstCluster))
			case "truncated":
				writeAt(t, o, []byte{0}, 510)
			}
			out, err := Parse(context.Background(), o, ReaderOptions{})
			var consistency *ConsistencyError
			if !errors.As(err, &consistency) || out.Safe {
				t.Fatalf("accepted corruption: %v", err)
			}
		})
	}
	o := NewMemoryOverlay(v)
	defer o.Close()
	writeAt(t, o, []byte{42}, int64(l.Geometry.ReservedSectors+l.Geometry.FATSectors)*512+100)
	out := parseOK(t, o)
	if len(out.Warnings) != 1 {
		t.Fatal("FAT mismatch not reported")
	}
}

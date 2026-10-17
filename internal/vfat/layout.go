package vfat

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"sort"
	"strings"
	"time"
)

const sectorSize = 512
const maxSectors = uint64(0xffffffff)

type LayoutVersion uint32

const (
	// LayoutLegacy reproduces the original 32-reserved-sector layout, including
	// its cluster-size selection. Use only to reopen existing overlays.
	LayoutLegacy  LayoutVersion = 1
	LayoutAligned LayoutVersion = 2
)

type Options struct {
	LayoutVersion     LayoutVersion `json:",omitempty"` // Zero selects LayoutAligned; persist an explicit version for recovery.
	UTCOffsetMinutes  int           `json:",omitempty"`
	Label             string
	Size              int64
	WritableBytes     int64
	ClusterSize       int
	Serial            uint32
	Time              time.Time
	MaxDirectoryBytes int64 // Default 64 MiB, including cluster padding.
	MaxDepth          int   // Default 64.
	ExcludeName       string
}

type Geometry struct {
	Size            int64
	ClusterSize     int
	ReservedSectors uint32
	FATSectors      uint32
	FATs            uint32
	Clusters        uint32
	RootCluster     uint32
}

func (g Geometry) DataOffset() int64 { return int64(g.ReservedSectors+g.FATs*g.FATSectors) * 512 }
func (g Geometry) ClusterOffset(c uint32) int64 {
	return g.DataOffset() + int64(c-2)*int64(g.ClusterSize)
}

type Entry struct {
	Path         string
	Node         Node
	FirstCluster uint32
	Chain        []ClusterRange
	directory    []byte
	children     []*Entry
	short        [11]byte
	flags        byte
	long         bool
}

type Layout struct {
	Geometry  Geometry
	Entries   []*Entry // Root first, followed by deterministic preorder.
	Skipped   []Skipped
	ID        [32]byte // Binds overlays to the exact snapshot, geometry and metadata.
	intervals []allocation
	boot      [512]byte
	fsinfo    [512]byte
	location  *time.Location
}

type allocation struct {
	ClusterRange
	entry *Entry
}

// RecommendedClusterSize follows Microsoft's FAT32 format table; tiny volumes
// use 512 bytes. Build applies a 4 KiB floor for aligned layouts and enlarges
// volumes to the minimum FAT32 cluster count.
func RecommendedClusterSize(size int64) int {
	sectors := (size + 511) / 512
	switch {
	case sectors <= 532480:
		return 512
	case sectors <= 16777216:
		return 4096
	case sectors <= 33554432:
		return 8192
	case sectors <= 67108864:
		return 16384
	default:
		return 32768
	}
}

func Build(tree Tree, opts Options) (*Layout, error) {
	if opts.UTCOffsetMinutes < -720 || opts.UTCOffsetMinutes > 840 {
		return nil, fmt.Errorf("invalid UTC offset minutes")
	}
	if opts.LayoutVersion == 0 {
		opts.LayoutVersion = LayoutAligned
	}
	if opts.LayoutVersion != LayoutLegacy && opts.LayoutVersion != LayoutAligned {
		return nil, fmt.Errorf("unsupported layout version %d", opts.LayoutVersion)
	}
	if opts.Size < 0 || opts.WritableBytes < 0 || uint64(opts.Size) > maxSectors*512 {
		return nil, fmt.Errorf("invalid volume size (maximum 2 TiB minus one sector)")
	}
	if opts.MaxDirectoryBytes == 0 {
		opts.MaxDirectoryBytes = 64 << 20
	}
	if opts.MaxDepth == 0 {
		opts.MaxDepth = 64
	}
	if opts.MaxDirectoryBytes < 512 || opts.MaxDepth < 1 || opts.MaxDepth > 1024 {
		return nil, fmt.Errorf("invalid layout limits")
	}
	label := strings.ToUpper(strings.TrimSpace(opts.Label))
	if label == "" {
		label = "NASDISK"
	}
	if len(label) > 11 {
		return nil, fmt.Errorf("volume label exceeds 11 bytes")
	}
	for _, c := range label {
		if !strings.ContainsRune("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-", c) {
			return nil, fmt.Errorf("invalid volume label")
		}
	}
	l := &Layout{location: time.FixedZone("FAT", opts.UTCOffsetMinutes*60)}
	root := &Entry{Path: "/", Node: Node{Dir: true, Mtime: opts.Time}}
	l.Entries = append(l.Entries, root)
	var rawDirectoryBytes int64
	var scan func(*Entry, []Node, int) error
	scan = func(parent *Entry, nodes []Node, depth int) error {
		nodes = append([]Node(nil), nodes...)
		sort.SliceStable(nodes, func(i, j int) bool { return nodes[i].Name < nodes[j].Name })
		seen := map[string]bool{}
		used := map[[11]byte]bool{}
		reserved := map[[11]byte]bool{}
		for _, n := range nodes {
			if s, _, ok := directShort(n.Name); ok {
				reserved[s] = true
			}
		}
		units := 3 // dots/label plus end marker
		for _, n := range nodes {
			p := strings.TrimSuffix(parent.Path, "/") + "/" + n.Name
			if opts.ExcludeName != "" && n.Name == opts.ExcludeName {
				l.Skipped = append(l.Skipped, Skipped{p, "excluded directory"})
				continue
			}
			reason := ""
			switch {
			case !validName(n.Name):
				reason = "invalid FAT name or more than 255 UTF-16 units"
			case depth > opts.MaxDepth:
				reason = "path depth limit"
			case n.Mode.Type() != 0 && n.Mode.Type() != fs.ModeDir:
				reason = "symbolic link or special file"
			case !n.Dir && (n.Size < 0 || n.Size >= 1<<32):
				reason = "file size outside FAT32 range"
			case seen[strings.ToUpper(n.Name)]:
				reason = "case-insensitive duplicate"
			}
			if reason != "" {
				l.Skipped = append(l.Skipped, Skipped{p, reason})
				continue
			}
			seen[strings.ToUpper(n.Name)] = true
			// Reserve direct names before generating aliases, including later siblings.
			if s, _, ok := directShort(n.Name); ok && !used[s] {
				delete(reserved, s)
			}
			s, f, long := makeShort(n.Name, reserved)
			cost := 1
			if long {
				cost += len(longEntries(n.Name, s)) / 32
			}
			if units+cost > 65535 {
				l.Skipped = append(l.Skipped, Skipped{p, "directory entry limit"})
				continue
			}
			units += cost
			used[s] = true
			children := n.Children
			n.Children = nil
			if n.Dir {
				n.Size = 0
			}
			if n.Mtime.IsZero() {
				n.Mtime = opts.Time
			}
			e := &Entry{Path: p, Node: n, short: s, flags: f, long: long}
			parent.children = append(parent.children, e)
			l.Entries = append(l.Entries, e)
			if n.Dir {
				if err := scan(e, children, depth+1); err != nil {
					return err
				}
			}
		}
		rawDirectoryBytes += int64(units * 32)
		if rawDirectoryBytes > opts.MaxDirectoryBytes {
			return fmt.Errorf("directory memory limit exceeded")
		}
		parent.directory = make([]byte, units*32)
		return nil
	}
	if err := scan(root, tree.Children, 1); err != nil {
		return nil, err
	}
	cs := opts.ClusterSize
	if cs == 0 {
		var size int64
		for _, e := range l.Entries {
			size += e.Node.Size + int64(len(e.directory))
		}
		if size > int64(maxSectors*512)-opts.WritableBytes {
			return nil, fmt.Errorf("volume too large")
		}
		cs = RecommendedClusterSize(max(opts.Size, size+opts.WritableBytes))
		if opts.LayoutVersion == LayoutAligned {
			cs = max(4096, cs)
		}
	}
	if cs < 512 || cs > 32768 || cs&(cs-1) != 0 {
		return nil, fmt.Errorf("cluster size must be a power of two from 512 to 32768")
	}
	if opts.LayoutVersion == LayoutAligned && cs < 4096 {
		return nil, fmt.Errorf("aligned layouts require clusters of at least 4096 bytes")
	}
	var used uint64
	var directoryBytes int64
	for _, e := range l.Entries {
		size := e.Node.Size
		if e.Node.Dir {
			size = int64(len(e.directory))
		}
		n := (uint64(size) + uint64(cs) - 1) / uint64(cs)
		if e.Node.Dir {
			directoryBytes += int64(n) * int64(cs)
			if directoryBytes > opts.MaxDirectoryBytes {
				return nil, fmt.Errorf("directory memory limit exceeded")
			}
		}
		if n > 0 {
			if used+n > 0x0fffffee {
				return nil, fmt.Errorf("too many allocated clusters")
			}
			e.FirstCluster = uint32(used + 2)
			e.Chain = []ClusterRange{{uint32(used + 2), uint32(used + n + 1)}}
			l.intervals = append(l.intervals, allocation{e.Chain[0], e})
			used += n
		}
	}
	clusters := max(uint64(65525), used+(uint64(opts.WritableBytes)+uint64(cs)-1)/uint64(cs))
	spc := uint64(cs / sectorSize)
	metadataSectors := func(count uint64) uint64 {
		fat := ((count+2)*4 + 511) / 512
		if opts.LayoutVersion == LayoutAligned {
			fat = roundSectors(fat, 8)
			return roundSectors(32+2*fat, spc)
		}
		return 32 + 2*fat
	}
	sectors := metadataSectors(clusters) + clusters*spc
	if opts.Size > 0 {
		sectors = max(uint64((opts.Size+511)/512), metadataSectors(65525)+65525*spc)
	}
	if sectors > maxSectors {
		return nil, fmt.Errorf("volume exceeds FAT32 sector limit")
	}
	// Solve geometry without alternating FAT-size fixed points at sector boundaries.
	fat := (sectors - 32 + uint64(cs/512)*2 + uint64(128*cs/512+2) - 1) / uint64(128*cs/512+2)
	reserved := uint64(32)
	if opts.LayoutVersion == LayoutAligned {
		// Find the smallest FAT (in 4 KiB units) that can address every data
		// cluster. Data start is monotone even as reserved-sector padding varies.
		low, high := uint64(1), roundSectors(fat, 8)/8
		for low < high {
			mid := (low + high) / 2
			data := roundSectors(32+2*mid*8, spc)
			if mid*8*128 >= (sectors-data)/spc+2 {
				high = mid
			} else {
				low = mid + 1
			}
		}
		fat = low * 8
		reserved = roundSectors(32+2*fat, spc) - 2*fat
	}
	clusters = (sectors - reserved - 2*fat) / spc
	if clusters < 65525 || clusters > 0x0fffffee || clusters < used {
		return nil, fmt.Errorf("volume cannot hold snapshot with FAT32 geometry")
	}
	l.Geometry = Geometry{int64(sectors * 512), cs, uint32(reserved), uint32(fat), 2, uint32(clusters), 2}
	recommended := RecommendedClusterSize(l.Geometry.Size)
	if opts.LayoutVersion == LayoutAligned {
		recommended = max(4096, recommended)
	}
	if opts.ClusterSize == 0 && recommended != cs {
		opts.ClusterSize = recommended
		return Build(tree, opts)
	}
	parents := map[*Entry]*Entry{}
	for _, e := range l.Entries {
		for _, c := range e.children {
			parents[c] = e
		}
	}
	for _, e := range l.Entries {
		if !e.Node.Dir {
			continue
		}
		b := make([]byte, 0, len(e.directory))
		if e == root {
			var s [11]byte
			copy(s[:], fmt.Sprintf("%-11s", label))
			b = append(b, shortEntry(s, 0, 8, 0, 0, opts.Time, l.location)...)
		} else {
			b = append(b, shortEntry(packShort(".", ""), 0, 16, e.FirstCluster, 0, e.Node.Mtime, l.location)...)
			pc := parents[e].FirstCluster
			if parents[e] == root {
				pc = 0
			}
			b = append(b, shortEntry(packShort("..", ""), 0, 16, pc, 0, parents[e].Node.Mtime, l.location)...)
		}
		for _, c := range e.children {
			if c.long {
				b = append(b, longEntries(c.Node.Name, c.short)...)
			}
			attr := byte(32)
			if c.Node.Dir {
				attr = 16
			}
			b = append(b, shortEntry(c.short, c.flags, attr, c.FirstCluster, c.Node.Size, c.Node.Mtime, l.location)...)
		}
		b = append(b, make([]byte, 32)...)
		e.directory = b
	}
	l.makeBoot(label, opts.Serial, uint32(used))
	h := sha256.New()
	h.Write(l.boot[:])
	if opts.UTCOffsetMinutes != 0 {
		fmt.Fprintf(h, "utcOffsetMinutes=%d", opts.UTCOffsetMinutes)
	}
	for _, e := range l.Entries {
		b, _ := json.Marshal(e)
		h.Write(b)
		h.Write(e.directory)
	}
	copy(l.ID[:], h.Sum(nil))
	return l, nil
}

func roundSectors(sectors, alignment uint64) uint64 {
	return (sectors + alignment - 1) / alignment * alignment
}

func (l *Layout) makeBoot(label string, serial, used uint32) {
	g := l.Geometry
	b := l.boot[:]
	copy(b, []byte{0xeb, 0x58, 0x90})
	copy(b[3:], "VIM4VFAT")
	le.PutUint16(b[11:], 512)
	b[13] = byte(g.ClusterSize / 512)
	le.PutUint16(b[14:], uint16(g.ReservedSectors))
	b[16] = 2
	b[21] = 0xf8
	le.PutUint16(b[24:], 63)
	le.PutUint16(b[26:], 255)
	le.PutUint32(b[32:], uint32(g.Size/512))
	le.PutUint32(b[36:], g.FATSectors)
	le.PutUint32(b[44:], 2)
	le.PutUint16(b[48:], 1)
	le.PutUint16(b[50:], 6)
	b[64] = 0x80
	b[66] = 0x29
	le.PutUint32(b[67:], serial)
	copy(b[71:], fmt.Sprintf("%-11s", label))
	copy(b[82:], "FAT32   ")
	b[510] = 0x55
	b[511] = 0xaa
	f := l.fsinfo[:]
	le.PutUint32(f, 0x41615252)
	le.PutUint32(f[484:], 0x61417272)
	le.PutUint32(f[488:], g.Clusters-used)
	next := used + 2
	if used == g.Clusters {
		next = 0xffffffff
	}
	le.PutUint32(f[492:], next)
	le.PutUint32(f[508:], 0xaa550000)
}

func (l *Layout) allocation(c uint32) *allocation {
	i := sort.Search(len(l.intervals), func(i int) bool { return l.intervals[i].End >= c })
	if i < len(l.intervals) && l.intervals[i].Start <= c {
		return &l.intervals[i]
	}
	return nil
}

func (l *Layout) fatEntry(c uint32) uint32 {
	if c == 0 {
		return 0x0ffffff8
	}
	if c == 1 {
		return 0x0fffffff
	}
	a := l.allocation(c)
	if a == nil {
		return 0
	}
	if c == a.End {
		return 0x0fffffff
	}
	return c + 1
}

type Volume struct {
	Layout *Layout
	source Source
}

func NewVolume(layout *Layout, source Source) *Volume { return &Volume{layout, source} }

func (v *Volume) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 {
		return 0, fmt.Errorf("negative read offset")
	}
	if len(p) == 0 {
		return 0, nil
	}
	g := v.Layout.Geometry
	if off >= g.Size {
		return 0, io.EOF
	}
	want := len(p)
	if int64(len(p)) > g.Size-off {
		p = p[:g.Size-off]
	}
	n := 0
	for len(p) > 0 {
		var b [512]byte
		sector := off / 512
		within := int(off % 512)
		take := min(len(p), 512-within)
		if sector < int64(g.ReservedSectors) {
			switch sector {
			case 0, 6:
				b = v.Layout.boot
			case 1, 7:
				b = v.Layout.fsinfo
			}
		} else if off < g.DataOffset() {
			fatSector := (sector - int64(g.ReservedSectors)) % int64(g.FATSectors)
			for i := 0; i < 128; i++ {
				le.PutUint32(b[i*4:], v.Layout.fatEntry(uint32(fatSector*128+int64(i))))
			}
		} else {
			c := uint32((off-g.DataOffset())/int64(g.ClusterSize)) + 2
			a := v.Layout.allocation(c)
			if a != nil {
				fileOff := (sector*512 - g.ClusterOffset(a.Start))
				if a.entry.Node.Dir {
					if fileOff < int64(len(a.entry.directory)) {
						copy(b[:], a.entry.directory[fileOff:])
					}
				} else if fileOff < a.entry.Node.Size {
					if v.source == nil {
						return n, fmt.Errorf("missing source for %s", a.entry.Path)
					}
					length := min(int64(512), a.entry.Node.Size-fileOff)
					read, err := v.source.ReadAt(a.entry.Node.SourceID, b[:length], fileOff)
					if err != nil && !(err == io.EOF && int64(read) == length) {
						return n, err
					}
					if int64(read) != length {
						return n, io.ErrUnexpectedEOF
					}
				}
			}
		}
		copy(p[:take], b[within:within+take])
		p = p[take:]
		off += int64(take)
		n += take
	}
	if n < want {
		return n, io.EOF
	}
	return n, nil
}

package vfat

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode/utf16"
)

type ParsedNode struct {
	Path, Name   string
	Dir          bool
	Size         int64
	FirstCluster uint32
	Chain        []ClusterRange
	Mtime        time.Time
	Attributes   byte
}

type Result struct {
	Geometry Geometry
	Nodes    []ParsedNode // Includes root, in disk directory order.
	Warnings []string
	Safe     bool // True only after complete validation, including both FATs.
	reader   io.ReaderAt
}

type ReaderOptions struct {
	UTCOffsetMinutes  int
	MaxEntries        int   // Default 1,000,000.
	MaxClusters       int   // Default 16,777,216; bounds chain ownership memory/work.
	MaxDirectoryBytes int64 // Default 64 MiB across all directories.
	MaxDepth          int   // Default 64.
}

type ConsistencyError struct{ Path, Reason string }

func (e *ConsistencyError) Error() string {
	return fmt.Sprintf("inconsistent FAT32 at %s: %s", e.Path, e.Reason)
}

type parser struct {
	ctx            context.Context
	r              io.ReaderAt
	out            *Result
	opts           ReaderOptions
	owners         map[uint32]string
	fatOffset      int64
	cachedSector   int64
	cache          [512]byte
	directoryBytes int64
	location       *time.Location
}

func Parse(ctx context.Context, r io.ReaderAt, opts ReaderOptions) (*Result, error) {
	out := &Result{reader: r}
	if opts.UTCOffsetMinutes < -720 || opts.UTCOffsetMinutes > 840 {
		return out, fmt.Errorf("invalid UTC offset minutes")
	}
	p := &parser{ctx: ctx, r: r, out: out, opts: opts, owners: map[uint32]string{}, cachedSector: -1, location: time.FixedZone("FAT", opts.UTCOffsetMinutes*60)}
	if p.opts.MaxEntries == 0 {
		p.opts.MaxEntries = 1000000
	}
	if p.opts.MaxClusters == 0 {
		p.opts.MaxClusters = 1 << 24
	}
	if p.opts.MaxDirectoryBytes == 0 {
		p.opts.MaxDirectoryBytes = 64 << 20
	}
	if p.opts.MaxDepth == 0 {
		p.opts.MaxDepth = 64
	}
	if p.opts.MaxEntries < 1 || p.opts.MaxClusters < 1 || p.opts.MaxDirectoryBytes < 512 || p.opts.MaxDepth < 1 || p.opts.MaxDepth > 1024 {
		return out, fmt.Errorf("invalid reader limits")
	}
	if err := p.boot(); err != nil {
		return out, err
	}
	root := ParsedNode{Path: "/", Dir: true, FirstCluster: out.Geometry.RootCluster, Attributes: 16}
	if err := p.visit(root, 0, 0); err != nil {
		return out, err
	}
	out.Safe = true
	return out, nil
}

func (p *parser) bad(path, reason string) error { return &ConsistencyError{path, reason} }

func (p *parser) boot() error {
	var b [512]byte
	if _, err := p.r.ReadAt(b[:], 0); err != nil {
		return err
	}
	if b[510] != 0x55 || b[511] != 0xaa || le.Uint16(b[11:]) != 512 || le.Uint16(b[17:]) != 0 || le.Uint16(b[19:]) != 0 || le.Uint16(b[22:]) != 0 || le.Uint16(b[42:]) != 0 {
		return p.bad("/", "invalid FAT32 BPB")
	}
	spc := uint32(b[13])
	reserved := uint32(le.Uint16(b[14:]))
	fats := uint32(b[16])
	fat := le.Uint32(b[36:])
	total := le.Uint32(b[32:])
	root := le.Uint32(b[44:])
	flags := le.Uint16(b[40:])
	data := uint64(reserved) + uint64(fats)*uint64(fat)
	if spc == 0 || spc > 64 || spc&(spc-1) != 0 || reserved == 0 || (fats != 1 && fats != 2) || fat == 0 || data >= uint64(total) || flags&0xff70 != 0 || (b[21] != 0xf0 && b[21] < 0xf8) {
		return p.bad("/", "invalid volume geometry")
	}
	clusters := uint32((uint64(total) - data) / uint64(spc))
	if clusters < 65525 || clusters > 0x0fffffee || uint64(fat)*128 < uint64(clusters)+2 || root < 2 || root >= clusters+2 {
		return p.bad("/", "invalid FAT32 cluster count or root")
	}
	p.out.Geometry = Geometry{int64(total) * 512, int(spc) * 512, reserved, fat, fats, clusters, root}
	p.fatOffset = int64(reserved) * 512
	if flags&0x80 != 0 {
		active := uint32(flags & 15)
		if active >= fats {
			return p.bad("/", "invalid active FAT")
		}
		p.fatOffset += int64(active) * int64(fat) * 512
	}
	// Confirm the declared end exists, even when no file reaches it.
	var end [1]byte
	if _, err := p.r.ReadAt(end[:], int64(total)*512-1); err != nil {
		return p.bad("/", "truncated volume")
	}
	if fats == 2 {
		var a, b [65536]byte
		size := int64(fat) * 512
		different := false
		for off := int64(0); off < size; off += int64(len(a)) {
			if err := p.ctx.Err(); err != nil {
				return err
			}
			n := min(int64(len(a)), size-off)
			if _, err := p.r.ReadAt(a[:n], int64(reserved)*512+off); err != nil {
				return err
			}
			if _, err := p.r.ReadAt(b[:n], int64(reserved)*512+size+off); err != nil {
				return err
			}
			if !bytes.Equal(a[:n], b[:n]) {
				different = true
			}
		}
		if different {
			p.out.Warnings = append(p.out.Warnings, "FAT copies differ; parsed the BPB-selected FAT")
		}
	}
	a, err := p.fat(0)
	if err != nil {
		return err
	}
	b0, err := p.fat(1)
	if err != nil {
		return err
	}
	if a&0x0fffff00 != 0x0fffff00 || byte(a) != b[21] || b0&0x03ffffff != 0x03ffffff {
		return p.bad("/", "invalid reserved FAT entries")
	}
	if b0&0x0c000000 != 0x0c000000 {
		p.out.Warnings = append(p.out.Warnings, "FAT dirty or I/O-error status is set")
	}
	return nil
}

func (p *parser) fat(c uint32) (uint32, error) {
	sector := int64(c / 128)
	if sector != p.cachedSector {
		if _, err := p.r.ReadAt(p.cache[:], p.fatOffset+sector*512); err != nil {
			return 0, err
		}
		p.cachedSector = sector
	}
	return le.Uint32(p.cache[(c%128)*4:]) & 0x0fffffff, nil
}

func (p *parser) chain(n ParsedNode) ([]ClusterRange, error) {
	if n.FirstCluster == 0 {
		if n.Dir || n.Size != 0 {
			return nil, p.bad(n.Path, "missing cluster chain")
		}
		return nil, nil
	}
	var ranges []ClusterRange
	c := n.FirstCluster
	count := int64(0)
	for {
		if err := p.ctx.Err(); err != nil {
			return nil, err
		}
		if c < 2 || c >= p.out.Geometry.Clusters+2 {
			return nil, p.bad(n.Path, "cluster outside data region")
		}
		if owner, ok := p.owners[c]; ok {
			return nil, p.bad(n.Path, "cycle or cross-link with "+owner)
		}
		if len(p.owners) >= p.opts.MaxClusters {
			return nil, fmt.Errorf("reader cluster limit exceeded")
		}
		p.owners[c] = n.Path
		ranges = addCluster(ranges, c)
		count++
		next, err := p.fat(c)
		if err != nil {
			return nil, err
		}
		if next >= 0x0ffffff8 {
			break
		}
		if next < 2 || next >= 0x0ffffff0 {
			return nil, p.bad(n.Path, "free, reserved or bad cluster in chain")
		}
		c = next
	}
	if !n.Dir && count != (n.Size+int64(p.out.Geometry.ClusterSize)-1)/int64(p.out.Geometry.ClusterSize) {
		return nil, p.bad(n.Path, "file size and chain length disagree")
	}
	return ranges, nil
}

func (p *parser) visit(n ParsedNode, parent uint32, depth int) error {
	if depth > p.opts.MaxDepth {
		return fmt.Errorf("reader depth limit exceeded at %s", n.Path)
	}
	if len(p.out.Nodes) >= p.opts.MaxEntries {
		return fmt.Errorf("reader entry limit exceeded")
	}
	chain, err := p.chain(n)
	if err != nil {
		return err
	}
	n.Chain = chain
	p.out.Nodes = append(p.out.Nodes, n)
	if !n.Dir {
		return nil
	}
	var data []byte
	g := p.out.Geometry
	for _, r := range chain {
		for c := r.Start; c <= r.End; c++ {
			p.directoryBytes += int64(g.ClusterSize)
			if p.directoryBytes > p.opts.MaxDirectoryBytes {
				return fmt.Errorf("reader directory memory limit exceeded")
			}
			at := len(data)
			data = append(data, make([]byte, g.ClusterSize)...)
			if _, err := p.r.ReadAt(data[at:], g.ClusterOffset(c)); err != nil {
				return err
			}
		}
	}
	var children []ParsedNode
	seen := map[string]bool{}
	lfn := lfnState{}
	dot, dotdot := false, false
	for off := 0; off+32 <= len(data); off += 32 {
		if err := p.ctx.Err(); err != nil {
			return err
		}
		e := data[off : off+32]
		if e[0] == 0 {
			break
		}
		if e[0] == 0xe5 {
			lfn = lfnState{}
			continue
		}
		if e[11] == 15 {
			lfn.add(e)
			continue
		}
		name := decodeShort(e)
		if long, ok := lfn.name(e); ok {
			name = long
		}
		lfn = lfnState{}
		if e[11]&8 != 0 {
			if n.Path != "/" || e[11]&16 != 0 {
				return p.bad(n.Path, "invalid volume label entry")
			}
			continue
		}
		first := uint32(le.Uint16(e[20:]))<<16 | uint32(le.Uint16(e[26:]))
		size := int64(le.Uint32(e[28:]))
		dir := e[11]&16 != 0
		if name == "." || name == ".." {
			expected := n.FirstCluster
			if name == ".." {
				expected = parent
			}
			if n.Path == "/" || !dir || size != 0 || first != expected {
				return p.bad(n.Path, "invalid dot directory entry")
			}
			if name == "." {
				if dot {
					return p.bad(n.Path, "duplicate dot entry")
				}
				dot = true
			} else {
				if dotdot {
					return p.bad(n.Path, "duplicate dotdot entry")
				}
				dotdot = true
			}
			continue
		}
		if !validName(name) || seen[strings.ToUpper(name)] || e[11]&0xc0 != 0 || first&0xf0000000 != 0 {
			return p.bad(n.Path, "invalid or duplicate directory name/entry")
		}
		seen[strings.ToUpper(name)] = true
		if dir && size != 0 {
			return p.bad(n.Path, "directory has nonzero size")
		}
		path := strings.TrimSuffix(n.Path, "/") + "/" + name
		children = append(children, ParsedNode{Path: path, Name: name, Dir: dir, Size: size, FirstCluster: first, Mtime: decodeTime(le.Uint16(e[24:]), le.Uint16(e[22:]), p.location), Attributes: e[11]})
		if len(children)+len(p.out.Nodes) > p.opts.MaxEntries {
			return fmt.Errorf("reader entry limit exceeded")
		}
	}
	if n.Path != "/" && (!dot || !dotdot) {
		return p.bad(n.Path, "missing dot directory entries")
	}
	for _, child := range children {
		pc := n.FirstCluster
		if n.Path == "/" {
			pc = 0
		}
		if err := p.visit(child, pc, depth+1); err != nil {
			return err
		}
	}
	return nil
}

type lfnState struct {
	units []uint16
	next  int
	sum   byte
	valid bool
}

func (l *lfnState) add(e []byte) {
	ordinal := int(e[0] & 31)
	if e[0]&0x40 != 0 {
		*l = lfnState{units: make([]uint16, ordinal*13), next: ordinal, sum: e[13], valid: ordinal > 0 && ordinal <= 20}
	}
	if !l.valid || ordinal != l.next || ordinal == 0 || e[0]&0xa0 != 0 || e[12] != 0 || le.Uint16(e[26:]) != 0 || e[13] != l.sum {
		l.valid = false
		return
	}
	for j, off := range lfnOffsets {
		l.units[(ordinal-1)*13+j] = le.Uint16(e[off:])
	}
	l.next--
}
func (l *lfnState) name(e []byte) (string, bool) {
	if !l.valid || l.next != 0 || checksum(e[:11]) != l.sum {
		return "", false
	}
	end := len(l.units)
	terminated := false
	for i, u := range l.units {
		if !terminated && u == 0 {
			end = i
			terminated = true
			continue
		}
		if terminated && u != 0xffff {
			return "", false
		}
		if !terminated && u == 0xffff {
			return "", false
		}
	}
	u := l.units[:end]
	if len(u) == 0 || len(u) > 255 {
		return "", false
	}
	for i := 0; i < len(u); i++ {
		if u[i] >= 0xd800 && u[i] <= 0xdbff {
			if i+1 == len(u) || u[i+1] < 0xdc00 || u[i+1] > 0xdfff {
				return "", false
			}
			i++
		} else if u[i] >= 0xdc00 && u[i] <= 0xdfff {
			return "", false
		}
	}
	name := string(utf16.Decode(u))
	return name, validName(name)
}

// ReadFileAt reads a validated final node's contents from the original ReaderAt.
func (r *Result) ReadFileAt(node ParsedNode, p []byte, off int64) (int, error) {
	if !r.Safe || r.reader == nil {
		return 0, fmt.Errorf("result has not passed validation")
	}
	return r.readFileAt(node, p, off)
}

// ReadRecoveredFileAt reads only a file whose complete chain was accepted before
// Parse stopped. It does not certify the volume or authorize deletion of entries
// absent from a partial result. Callers must require an explicit recovery choice.
func (r *Result) ReadRecoveredFileAt(node ParsedNode, p []byte, off int64) (int, error) {
	if r.reader == nil {
		return 0, fmt.Errorf("missing volume reader")
	}
	for _, accepted := range r.Nodes {
		if !accepted.Dir && accepted.Path == node.Path {
			return r.readFileAt(accepted, p, off)
		}
	}
	return 0, fmt.Errorf("file was not recovered")
}

func (r *Result) readFileAt(node ParsedNode, p []byte, off int64) (int, error) {
	if node.Dir || off < 0 {
		return 0, fmt.Errorf("invalid file read")
	}
	if len(p) == 0 {
		return 0, nil
	}
	if off >= node.Size {
		return 0, io.EOF
	}
	want := len(p)
	if int64(len(p)) > node.Size-off {
		p = p[:node.Size-off]
	}
	n := 0
	cs := int64(r.Geometry.ClusterSize)
	for _, chain := range node.Chain {
		size := int64(chain.End-chain.Start+1) * cs
		if off >= size {
			off -= size
			continue
		}
		take := min(int64(len(p)), size-off)
		got, err := r.reader.ReadAt(p[:take], r.Geometry.ClusterOffset(chain.Start)+off)
		n += got
		if err != nil {
			return n, err
		}
		if int64(got) != take {
			return n, io.ErrUnexpectedEOF
		}
		p = p[take:]
		off = 0
		if len(p) == 0 {
			break
		}
	}
	if len(p) > 0 {
		return n, io.ErrUnexpectedEOF
	}
	if n < want {
		return n, io.EOF
	}
	return n, nil
}

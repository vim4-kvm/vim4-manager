package vfat

import (
	"bytes"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"syscall"
)

const overlayBlock = 4096

type Overlay interface {
	io.ReaderAt
	io.WriterAt
	DirtyClusters() []ClusterRange
	Sync() error
	Close() error
	WrittenBytes() int64
}

type overlay struct {
	mu          sync.Mutex
	base        *Volume
	blocks      map[int64][]byte
	positions   map[int64]int64
	data, index *os.File
	closed      bool
	failed      error
	written     int64
}

func NewMemoryOverlay(base *Volume) Overlay {
	return &overlay{base: base, blocks: map[int64][]byte{}, positions: map[int64]int64{}}
}

// OpenFileOverlay opens path and path+".index". The v1 header binds the layout ID,
// geometry and 4096-byte block size. Data is sparse, with copy-on-write versions
// appended after the logical volume. Each WriteAt fsyncs data before appending
// checksummed index records, then fsyncs the index. A torn trailing record is
// discarded on reopen. A successful write is durable; a failed write may be
// partially committed. A single process must own these files exclusively.
func OpenFileOverlay(base *Volume, path string) (Overlay, error) {
	o := &overlay{base: base, positions: map[int64]int64{}}
	var err error
	o.index, err = os.OpenFile(path+".index", os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0600)
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			if o.data != nil {
				o.data.Close()
			}
			o.index.Close()
		}
	}()
	stat, err := o.index.Stat()
	if err != nil {
		return nil, err
	}
	if !stat.Mode().IsRegular() || stat.Sys().(*syscall.Stat_t).Nlink != 1 {
		return nil, fmt.Errorf("overlay index is not a regular file")
	}
	header := make([]byte, 512)
	copy(header, "VIM4OVL1")
	le.PutUint32(header[8:], 1)
	le.PutUint32(header[12:], overlayBlock)
	le.PutUint64(header[16:], uint64(base.Layout.Geometry.Size))
	copy(header[24:], base.Layout.ID[:])
	le.PutUint32(header[508:], crc32.ChecksumIEEE(header[:508]))
	if stat.Size() == 0 {
		o.data, err = os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
		if err != nil {
			return nil, err
		}
		if err = o.data.Truncate((base.Layout.Geometry.Size + overlayBlock - 1) / overlayBlock * overlayBlock); err != nil {
			return nil, err
		}
		if err = o.data.Sync(); err != nil {
			return nil, err
		}
		if _, err = o.index.WriteAt(header, 0); err != nil {
			return nil, err
		}
		if err = o.index.Sync(); err != nil {
			return nil, err
		}
		directory, err := os.Open(filepath.Dir(path))
		if err != nil {
			return nil, err
		}
		err = directory.Sync()
		closeErr := directory.Close()
		if err != nil {
			return nil, err
		}
		if closeErr != nil {
			return nil, closeErr
		}
	} else {
		got := make([]byte, 512)
		if _, err = o.index.ReadAt(got, 0); err != nil {
			return nil, err
		}
		if !bytes.Equal(header, got) {
			return nil, fmt.Errorf("overlay version or snapshot geometry mismatch")
		}
		o.data, err = os.OpenFile(path, os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0600)
		if err != nil {
			return nil, err
		}
		dataStat, err := o.data.Stat()
		if err != nil {
			return nil, err
		}
		if !dataStat.Mode().IsRegular() || dataStat.Sys().(*syscall.Stat_t).Nlink != 1 {
			return nil, fmt.Errorf("overlay data is not a regular file")
		}
		var rec [24]byte
		at := int64(512)
		for at+24 <= stat.Size() {
			if _, err = o.index.ReadAt(rec[:], at); err != nil {
				return nil, err
			}
			if crc32.ChecksumIEEE(rec[:20]) != le.Uint32(rec[20:]) {
				if at+24 == stat.Size() {
					break
				}
				return nil, fmt.Errorf("corrupt overlay index")
			}
			block, pos := int64(le.Uint64(rec[:])), int64(le.Uint64(rec[8:]))
			if block < 0 || block >= (base.Layout.Geometry.Size+overlayBlock-1)/overlayBlock || pos < 0 || pos%overlayBlock != 0 || pos > dataStat.Size()-overlayBlock {
				return nil, fmt.Errorf("invalid overlay record")
			}
			b := make([]byte, overlayBlock)
			if _, err = o.data.ReadAt(b, pos); err != nil {
				return nil, err
			}
			if crc32.ChecksumIEEE(b) != le.Uint32(rec[16:]) {
				return nil, fmt.Errorf("corrupt overlay data")
			}
			o.positions[block] = pos
			o.written += overlayBlock
			at += 24
		}
		if err = o.index.Truncate(at); err != nil {
			return nil, err
		}
	}
	ok = true
	return o, nil
}

func (o *overlay) readBlock(block int64, b []byte) error {
	if o.data == nil {
		if data, ok := o.blocks[block]; ok {
			copy(b, data)
			return nil
		}
	} else if pos, ok := o.positions[block]; ok {
		_, err := o.data.ReadAt(b, pos)
		return err
	}
	clear(b)
	n, err := o.base.ReadAt(b, block*overlayBlock)
	if err == io.EOF && int64(n) == o.base.Layout.Geometry.Size-block*overlayBlock {
		return nil
	}
	return err
}

func (o *overlay) ReadAt(p []byte, off int64) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed {
		return 0, os.ErrClosed
	}
	if off < 0 {
		return 0, fmt.Errorf("negative read offset")
	}
	if len(p) == 0 {
		return 0, nil
	}
	size := o.base.Layout.Geometry.Size
	if off >= size {
		return 0, io.EOF
	}
	want := len(p)
	if int64(len(p)) > size-off {
		p = p[:size-off]
	}
	n := 0
	for len(p) > 0 {
		var b [overlayBlock]byte
		if err := o.readBlock(off/overlayBlock, b[:]); err != nil {
			return n, err
		}
		within := int(off % overlayBlock)
		take := min(len(p), overlayBlock-within)
		copy(p, b[within:within+take])
		p = p[take:]
		off += int64(take)
		n += take
	}
	if n < want {
		return n, io.EOF
	}
	return n, nil
}

func (o *overlay) WriteAt(p []byte, off int64) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed {
		return 0, os.ErrClosed
	}
	if o.failed != nil {
		return 0, o.failed
	}
	size := o.base.Layout.Geometry.Size
	if off < 0 || off > size || int64(len(p)) > size-off {
		return 0, fmt.Errorf("write outside volume")
	}
	n := 0
	for len(p) > 0 {
		b := make([]byte, overlayBlock)
		block := off / overlayBlock
		if err := o.readBlock(block, b); err != nil {
			return n, err
		}
		within := int(off % overlayBlock)
		take := min(len(p), overlayBlock-within)
		copy(b[within:], p[:take])
		if err := o.storeBlock(block, b); err != nil {
			o.failed = err
			return n, err
		}
		p = p[take:]
		off += int64(take)
		n += take
	}
	return n, nil
}

func (o *overlay) storeBlock(block int64, b []byte) error {
	if o.data == nil {
		o.blocks[block] = b
		o.written += overlayBlock
		return nil
	}
	pos := block * overlayBlock
	if _, ok := o.positions[block]; ok {
		stat, err := o.data.Stat()
		if err != nil {
			return err
		}
		pos = (stat.Size() + overlayBlock - 1) / overlayBlock * overlayBlock
	}
	if _, err := o.data.WriteAt(b, pos); err != nil {
		return err
	}
	if err := o.data.Sync(); err != nil {
		return err
	}
	var rec [24]byte
	le.PutUint64(rec[:], uint64(block))
	le.PutUint64(rec[8:], uint64(pos))
	le.PutUint32(rec[16:], crc32.ChecksumIEEE(b))
	le.PutUint32(rec[20:], crc32.ChecksumIEEE(rec[:20]))
	stat, err := o.index.Stat()
	if err != nil {
		return err
	}
	if _, err = o.index.WriteAt(rec[:], stat.Size()); err != nil {
		return err
	}
	if err = o.index.Sync(); err != nil {
		return err
	}
	o.positions[block] = pos
	o.written += overlayBlock
	return nil
}

// WrittenBytes includes overwritten block versions retained for crash recovery.
// Opening an existing overlay restores this value from its durable index.
func (o *overlay) WrittenBytes() int64 { o.mu.Lock(); defer o.mu.Unlock(); return o.written }

// DirtyClusters is conservative: every data cluster touched by a dirty overlay
// block is included, even if only another byte in that block was written.
// LayoutAligned keeps each data block within one cluster; LayoutLegacy may
// include untouched neighboring clusters because of its size or alignment.
func (o *overlay) DirtyClusters() []ClusterRange {
	o.mu.Lock()
	defer o.mu.Unlock()
	var blocks []int64
	if o.data == nil {
		for b := range o.blocks {
			blocks = append(blocks, b)
		}
	} else {
		for b := range o.positions {
			blocks = append(blocks, b)
		}
	}
	sort.Slice(blocks, func(i, j int) bool { return blocks[i] < blocks[j] })
	g := o.base.Layout.Geometry
	var result []ClusterRange
	for _, b := range blocks {
		start := max(b*overlayBlock, g.DataOffset())
		end := min((b+1)*overlayBlock, g.ClusterOffset(g.Clusters+2))
		if end <= start {
			continue
		}
		s := uint32((start-g.DataOffset())/int64(g.ClusterSize)) + 2
		e := uint32((end-1-g.DataOffset())/int64(g.ClusterSize)) + 2
		if len(result) > 0 && s <= result[len(result)-1].End+1 {
			result[len(result)-1].End = max(e, result[len(result)-1].End)
		} else {
			result = append(result, ClusterRange{s, e})
		}
	}
	return result
}

func (o *overlay) Sync() error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed {
		return os.ErrClosed
	}
	if o.failed != nil {
		return o.failed
	}
	if o.data == nil {
		return nil
	}
	if err := o.data.Sync(); err != nil {
		return err
	}
	return o.index.Sync()
}
func (o *overlay) Close() error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closed {
		return os.ErrClosed
	}
	o.closed = true
	if o.data == nil {
		return nil
	}
	a := o.data.Close()
	b := o.index.Close()
	if a != nil {
		return a
	}
	return b
}

package nasdisk

import (
	"io"
	"sync"
	"syscall"

	"github.com/vim4-kvm/vim4-manager/internal/vfat"
)

// Disk serializes the transition from host I/O to parsing. Release is only a
// hint: closing an auxiliary reader must never count as a host eject.
type Disk struct {
	mu           sync.RWMutex
	Reader       io.ReaderAt
	Overlay      vfat.Overlay
	Size         int64
	acceptWrites bool
	written      int64
	Released     chan struct{}
}

func (d *Disk) ReadAt(p []byte, off int64) (int, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.Reader.ReadAt(p, off)
}
func (d *Disk) WriteAt(p []byte, off int64) (int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.acceptWrites || d.Overlay == nil {
		return 0, syscall.EROFS
	}
	n, e := d.Overlay.WriteAt(p, off)
	d.written += int64(n)
	return n, e
}
func (d *Disk) Freeze() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.acceptWrites = false
	if d.Overlay != nil {
		return d.Overlay.Sync()
	}
	return nil
}
func (d *Disk) EnableWrites() { d.mu.Lock(); d.acceptWrites = d.Overlay != nil; d.mu.Unlock() }
func (d *Disk) Written() int64 {
	d.mu.RLock()
	defer d.mu.RUnlock()
	if d.Overlay != nil {
		return d.Overlay.WrittenBytes()
	}
	return 0
}
func (d *Disk) Release() {
	select {
	case d.Released <- struct{}{}:
	default:
	}
}

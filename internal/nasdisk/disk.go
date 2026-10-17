package nasdisk

import (
	"io"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/vfat"
)

// Stay below the common 30 s macOS/Windows/Linux SCSI command timeout,
// leaving room for f_mass_storage processing and host retries.
const diskIOTimeout = 8 * time.Second
const maxBackgroundIO = 4
const nasStallWindow = 10 * time.Second

// Disk bounds host I/O without cancelling syscalls already in the kernel.
// Reader, Overlay and Size are immutable after publication. Release is only a
// hint: closing an auxiliary reader must never count as a host eject.
type Disk struct {
	Reader   io.ReaderAt
	Overlay  vfat.Overlay
	Size     int64
	Released chan struct{}

	init         sync.Once
	gate         chan struct{}
	slots        chan struct{}
	ioTimeout    time.Duration // Zero uses diskIOTimeout; tests can shorten it.
	acceptWrites atomic.Bool
	written      atomic.Int64
	lastTimeout  atomic.Int64
	writeTimeout atomic.Bool
}

type diskResult struct {
	n    int
	err  error
	data []byte
}

func (d *Disk) stalled(write bool) diskResult {
	d.lastTimeout.Store(time.Now().UnixNano())
	if write {
		d.writeTimeout.Store(true)
	}
	return diskResult{err: syscall.EIO}
}

func (d *Disk) perform(p []byte, write bool, operation func([]byte) (int, error)) diskResult {
	d.init.Do(func() {
		d.gate = make(chan struct{}, 1)
		d.slots = make(chan struct{}, maxBackgroundIO)
	})
	timeout := d.ioTimeout
	if timeout == 0 {
		timeout = diskIOTimeout
	}
	deadline := time.Now().Add(timeout)
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	// Keep the gate until the actual backend operation completes, even after
	// returning EIO. Expired waiters never become background writes. Thus an
	// older delayed write cannot overwrite a later successful version.
	if d.Overlay != nil {
		select {
		case d.gate <- struct{}{}:
		case <-timer.C:
			return d.stalled(write)
		}
	}
	releaseGate := func() {
		if d.Overlay != nil {
			<-d.gate
		}
	}
	select {
	case d.slots <- struct{}{}:
	default:
		releaseGate()
		return diskResult{err: syscall.EIO}
	}
	if !time.Now().Before(deadline) {
		<-d.slots
		releaseGate()
		return d.stalled(write)
	}
	// FUSE owns p and can reuse it as soon as we return. Both reads and writes
	// need private storage while a timed-out syscall finishes in the background.
	data := make([]byte, len(p))
	if write {
		copy(data, p)
	}
	done := make(chan diskResult, 1)
	go func() {
		n, err := operation(data)
		<-d.slots
		releaseGate()
		done <- diskResult{n, err, data}
	}()
	select {
	case result := <-done:
		return result
	case <-timer.C:
		return d.stalled(write)
	}
}

func (d *Disk) ReadAt(p []byte, off int64) (int, error) {
	r := d.perform(p, false, func(data []byte) (int, error) { return d.Reader.ReadAt(data, off) })
	copy(p, r.data[:r.n])
	return r.n, r.err
}

func (d *Disk) WriteAt(p []byte, off int64) (int, error) {
	if !d.acceptWrites.Load() || d.Overlay == nil {
		return 0, syscall.EROFS
	}
	r := d.perform(p, true, func(data []byte) (int, error) {
		if !d.acceptWrites.Load() {
			return 0, syscall.EROFS
		}
		n, err := d.Overlay.WriteAt(data, off)
		d.written.Store(d.Overlay.WrittenBytes())
		return n, err
	})
	return r.n, r.err
}

func (d *Disk) Sync() error {
	if d.Overlay == nil {
		return nil
	}
	return d.perform(nil, true, func([]byte) (int, error) { return 0, d.Overlay.Sync() }).err
}

func (d *Disk) Freeze() error {
	d.acceptWrites.Store(false)
	return d.Sync()
}

func (d *Disk) EnableWrites() { d.acceptWrites.Store(d.Overlay != nil) }

// Written and NasStalled never take an overlay lock or touch the NAS.
func (d *Disk) Written() int64 { return d.written.Load() }
func (d *Disk) NasStalled(now time.Time) bool {
	last := d.lastTimeout.Load()
	return last != 0 && now.Sub(time.Unix(0, last)) < nasStallWindow
}

func (d *Disk) Release() {
	select {
	case d.Released <- struct{}{}:
	default:
	}
}

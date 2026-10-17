//go:build linux

package nasdisk

import (
	"context"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
)

type diskNode struct {
	fs.Inode
	disk *Disk
}

func (n *diskNode) Getattr(ctx context.Context, f fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	out.Mode = syscall.S_IFREG | 0600
	out.Size = uint64(n.disk.Size)
	out.Nlink = 1
	return 0
}
func (n *diskNode) Open(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	if flags&syscall.O_ACCMODE != syscall.O_RDONLY && n.disk.Overlay == nil {
		return nil, 0, syscall.EROFS
	}
	return nil, fuse.FOPEN_DIRECT_IO, 0
}
func (n *diskNode) Read(ctx context.Context, f fs.FileHandle, dest []byte, off int64) (fuse.ReadResult, syscall.Errno) {
	count, e := n.disk.ReadAt(dest, off)
	if e != nil && e != io.EOF {
		return nil, syscall.EIO
	}
	return fuse.ReadResultData(dest[:count]), 0
}
func (n *diskNode) Write(ctx context.Context, f fs.FileHandle, data []byte, off int64) (uint32, syscall.Errno) {
	count, e := n.disk.WriteAt(data, off)
	if e != nil {
		return uint32(count), fs.ToErrno(e)
	}
	return uint32(count), 0
}
func (n *diskNode) Fsync(ctx context.Context, f fs.FileHandle, flags uint32) syscall.Errno {
	return fs.ToErrno(n.disk.Sync())
}
func (n *diskNode) Release(ctx context.Context, f fs.FileHandle) syscall.Errno {
	n.disk.Release()
	return 0
}

// CleanupMount reads mountinfo instead of stat: stat on an abandoned FUSE mount
// can itself hang. Abort releases kernel waiters before the lazy unmount.
func CleanupMount(mountpoint string) error {
	data, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 10 {
			continue
		}
		decoded := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`).Replace(fields[4])
		if decoded != mountpoint {
			continue
		}
		if !strings.Contains(line, " - fuse.nasdisk ") {
			return fmt.Errorf("unexpected filesystem at %s", mountpoint)
		}
		device := strings.Split(fields[2], ":")
		if len(device) != 2 {
			return fmt.Errorf("invalid FUSE device")
		}
		minor, err := strconv.ParseUint(device[1], 10, 32)
		if err != nil {
			return err
		}
		err = os.WriteFile(fmt.Sprintf("/sys/fs/fuse/connections/%d/abort", minor), []byte("1\n"), 0200)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		if err = unix.Unmount(mountpoint, unix.MNT_DETACH); err != nil && err != syscall.EINVAL && err != syscall.ENOENT {
			return err
		}
	}
	return nil
}

func MountDisk(ctx context.Context, mountpoint, name string, disk *Disk) (func() error, error) {
	return waitForMount(ctx, func() (func() error, error) {
		root := &fs.Inode{}
		server, err := fs.Mount(mountpoint, root, &fs.Options{MountOptions: fuse.MountOptions{FsName: "vim4-nasdisk", Name: "nasdisk", DisableXAttrs: true}, OnAdd: func(ctx context.Context) {
			root.AddChild(name, root.NewPersistentInode(ctx, &diskNode{disk: disk}, fs.StableAttr{Mode: syscall.S_IFREG}), true)
		}})
		if err != nil {
			return nil, err
		}
		return func() error {
			done := make(chan error, 1)
			go func() { done <- server.Unmount() }()
			select {
			case err := <-done:
				if err == nil {
					return nil
				}
			case <-time.After(2 * time.Second):
			}
			return CleanupMount(mountpoint)
		}, nil
	}, func() error { return CleanupMount(mountpoint) })
}

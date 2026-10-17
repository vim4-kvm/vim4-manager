//go:build linux

package nasdisk

import (
	"context"
	"io"
	"syscall"

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
	if n.disk.Overlay != nil {
		return fs.ToErrno(n.disk.Overlay.Sync())
	}
	return 0
}
func (n *diskNode) Release(ctx context.Context, f fs.FileHandle) syscall.Errno {
	n.disk.Release()
	return 0
}

func MountDisk(mountpoint, name string, disk *Disk) (func() error, error) {
	root := &fs.Inode{}
	server, err := fs.Mount(mountpoint, root, &fs.Options{MountOptions: fuse.MountOptions{FsName: "vim4-nasdisk", Name: "nasdisk", DisableXAttrs: true}, OnAdd: func(ctx context.Context) {
		root.AddChild(name, root.NewPersistentInode(ctx, &diskNode{disk: disk}, fs.StableAttr{Mode: syscall.S_IFREG}), true)
	}})
	if err != nil {
		return nil, err
	}
	return server.Unmount, nil
}

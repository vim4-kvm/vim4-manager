package nasdisk

import (
	"fmt"
	"os"
	"runtime"

	"golang.org/x/sys/unix"
)

// Pin the private directory rather than repeatedly resolving a NAS-controlled
// pathname. Linux's fd directory lets the overlay's path API share this anchor.
func privateDirectory(root string, id string, create bool, anchor *os.File) (*os.File, string, error) {
	fd, e := unix.Dup(int(anchor.Fd()))
	if e != nil {
		return nil, "", e
	}
	for _, part := range []string{PrivateName, id} {
		if create {
			if e = unix.Mkdirat(fd, part, 0700); e != nil && (e != unix.EEXIST || part == id) {
				unix.Close(fd)
				return nil, "", e
			}
			if e = unix.Fsync(fd); e != nil {
				unix.Close(fd)
				return nil, "", e
			}
		}
		next, err := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(fd)
		if err != nil {
			return nil, "", err
		}
		fd = next
	}
	f := os.NewFile(uintptr(fd), root+"/"+PrivateName+"/"+id)
	if runtime.GOOS == "linux" {
		return f, fmt.Sprintf("/proc/self/fd/%d", fd), nil
	}
	return f, f.Name(), nil
}

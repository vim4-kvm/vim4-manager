//go:build !linux

package nasdisk

import "fmt"

func MountDisk(mountpoint, name string, disk *Disk) (func() error, error) {
	return nil, fmt.Errorf("NAS disk FUSE requires Linux")
}

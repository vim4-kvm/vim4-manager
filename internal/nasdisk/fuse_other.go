//go:build !linux

package nasdisk

import (
	"context"
	"fmt"
)

func MountDisk(ctx context.Context, mountpoint, name string, disk *Disk) (func() error, error) {
	return nil, fmt.Errorf("NAS disk FUSE requires Linux")
}

func CleanupMount(mountpoint string) error { return nil }

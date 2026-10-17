package nasdisk

import (
	"context"
	"fmt"
	"time"
)

const mountTimeout = 15 * time.Second

// waitForMount also bounds NewServer's INIT handshake, before WaitMount starts.
// Cleanup must not wait for the serving goroutines: a kernel waiter may need
// connection abort before either mounting or unmounting can complete.
func waitForMount(ctx context.Context, mount func() (func() error, error), cleanup func() error) (func() error, error) {
	ctx, cancel := context.WithTimeout(ctx, mountTimeout)
	defer cancel()
	type result struct {
		unmount func() error
		err     error
	}
	done := make(chan result)
	go func() {
		unmount, err := mount()
		select {
		case done <- result{unmount, err}:
		case <-ctx.Done():
			// The mount syscall may have finished after the first cleanup attempt.
			cleanup()
		}
	}()
	select {
	case mounted := <-done:
		if mounted.err != nil {
			cleanup()
			return nil, mounted.err
		}
		return mounted.unmount, nil
	case <-ctx.Done():
		cleanup()
		if ctx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("无法创建 U 盘镜像（FUSE 无响应）")
		}
		return nil, ctx.Err()
	}
}

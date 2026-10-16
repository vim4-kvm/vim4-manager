package board

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// StreamRunner connects the request and response directly to a cancellable helper.
type StreamRunner func(context.Context, io.Reader, io.Writer, string, ...string) error

// ExecStream terminates the process group, including mtools, on cancellation.
func ExecStream(ctx context.Context, input io.Reader, output io.Writer, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = []string{"LC_ALL=C", "PATH=/usr/sbin:/usr/bin:/sbin:/bin"}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) }
	cmd.WaitDelay = 2 * time.Second
	cmd.Stdin, cmd.Stdout = input, output
	var stderr limitedError
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if stderr.buffer.Len() > 0 {
			return fmt.Errorf("%s", strings.TrimSpace(stderr.buffer.String()))
		}
		return err
	}
	return nil
}

type limitedError struct{ buffer bytes.Buffer }

func (b *limitedError) Write(p []byte) (int, error) {
	n := len(p)
	if left := 16384 - b.buffer.Len(); left > 0 {
		_, _ = b.buffer.Write(p[:min(left, n)])
	}
	return n, nil
}

// DiskCommand deliberately bypasses the service switch mutex. The helper owns
// per-disk locks, so an upload never stops status polling or an unrelated switch.
func (s *Service) DiskCommand(ctx context.Context, action string, args ...string) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	var data bytes.Buffer
	if err := s.diskStream(ctx, nil, &data, append([]string{action}, args...)...); err != nil {
		return nil, err
	}
	if !json.Valid(data.Bytes()) {
		return nil, fmt.Errorf("数据盘响应无效")
	}
	return json.RawMessage(data.Bytes()), nil
}

func (s *Service) diskStream(ctx context.Context, input io.Reader, output io.Writer, args ...string) error {
	run := s.Stream
	if run == nil {
		run = ExecStream
	}
	return run(ctx, input, output, "sudo", append([]string{"-n", Helper}, args...)...)
}

func (s *Service) UploadDiskFile(ctx context.Context, disk, path string, size int64, overwrite bool, input io.Reader) error {
	if size < 0 || size > 1<<32-1 {
		return fmt.Errorf("需要 Content-Length，文件最大 4 GiB-1")
	}
	mode := "0"
	if overwrite {
		mode = "1"
	}
	return s.diskStream(ctx, input, io.Discard, "disk-put", disk, path, strconv.FormatInt(size, 10), mode)
}

func (s *Service) DownloadDisk(ctx context.Context, disk, path string, image bool, output io.Writer) error {
	if image {
		return s.diskStream(ctx, nil, output, "disk-image", disk)
	}
	return s.diskStream(ctx, nil, output, "disk-get", disk, path)
}

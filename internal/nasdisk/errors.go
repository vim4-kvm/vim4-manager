package nasdisk

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"syscall"

	"github.com/vim4-kvm/vim4-manager/internal/i18n"
	"github.com/vim4-kvm/vim4-manager/internal/vfat"
)

type sourceReadError struct {
	Path string
	Err  error
}

func (e *sourceReadError) Error() string        { return fmt.Sprintf("read NAS source %q: %v", e.Path, e.Err) }
func (e *sourceReadError) Unwrap() error        { return e.Err }
func (e *sourceReadError) Is(target error) bool { return target == syscall.EIO }

type payloadReadError struct {
	Path string
	Err  error
}

func (e *payloadReadError) Error() string {
	return fmt.Sprintf("read writeback file %q: %v", e.Path, e.Err)
}
func (e *payloadReadError) Unwrap() error { return e.Err }

func failureMessage(err error) string {
	var source *sourceReadError
	var payload *payloadReadError
	var consistency *vfat.ConsistencyError
	filePath := ""
	if errors.As(err, &source) {
		filePath = source.Path
	} else if errors.As(err, &payload) {
		filePath = payload.Path
	}
	if filePath != "" {
		return (i18n.Message{Key: "nasDisk.readSource", Args: map[string]any{"p0": filePath}}).Render(i18n.English)
	}
	switch {
	case errors.Is(err, syscall.ENOSPC), errors.Is(err, syscall.EDQUOT):
		return (i18n.Message{Key: "nasDisk.full"}).Render(i18n.English)
	case errors.Is(err, syscall.EACCES), errors.Is(err, syscall.EPERM), errors.Is(err, syscall.EROFS):
		return (i18n.Message{Key: "nasDisk.permission"}).Render(i18n.English)
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, syscall.ETIMEDOUT), errors.Is(err, syscall.EHOSTUNREACH), errors.Is(err, syscall.EHOSTDOWN), errors.Is(err, syscall.ENETUNREACH), errors.Is(err, syscall.ENOTCONN), errors.Is(err, syscall.ECONNRESET), errors.Is(err, syscall.ECONNREFUSED), errors.Is(err, syscall.ESTALE):
		return (i18n.Message{Key: "nasDisk.unreachable"}).Render(i18n.English)
	case errors.Is(err, syscall.EIO), errors.Is(err, io.ErrUnexpectedEOF):
		return (i18n.Message{Key: "nasDisk.readFailed"}).Render(i18n.English)
	case errors.As(err, &consistency), strings.HasPrefix(err.Error(), "reader "):
		return (i18n.Message{Key: "nasDisk.parseFailed"}).Render(i18n.English)
	case errors.Is(err, context.Canceled):
		return (i18n.Message{Key: "nasDisk.cancelled"}).Render(i18n.English)
	default:
		return (i18n.Message{Key: "nasDisk.writebackFailed"}).Render(i18n.English) + err.Error()
	}
}

package nasdisk

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"syscall"

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
		return fmt.Sprintf("读取 NAS 上的 %s 失败：文件在 U 盘挂载期间被改动，或 NAS 暂时无法访问", filePath)
	}
	switch {
	case errors.Is(err, syscall.ENOSPC), errors.Is(err, syscall.EDQUOT):
		return "NAS 空间不足，无法完成回写；请释放空间后重试"
	case errors.Is(err, syscall.EACCES), errors.Is(err, syscall.EPERM), errors.Is(err, syscall.EROFS):
		return "没有 NAS 写入权限或存储为只读，请检查权限后重试"
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, syscall.ETIMEDOUT), errors.Is(err, syscall.EHOSTUNREACH), errors.Is(err, syscall.EHOSTDOWN), errors.Is(err, syscall.ENETUNREACH), errors.Is(err, syscall.ENOTCONN), errors.Is(err, syscall.ECONNRESET), errors.Is(err, syscall.ECONNREFUSED), errors.Is(err, syscall.ESTALE):
		return "NAS 无响应或连接已中断，请恢复连接后重试"
	case errors.Is(err, syscall.EIO), errors.Is(err, io.ErrUnexpectedEOF):
		return "读取 U 盘数据失败：NAS 文件可能已被改动或存储暂时无法访问，请检查后重试"
	case errors.As(err, &consistency), strings.HasPrefix(err.Error(), "reader "):
		return "U 盘文件系统解析失败，请重新挂载到电脑检查，或选择恢复可识别内容"
	case errors.Is(err, context.Canceled):
		return "回写已取消，会话数据已保留"
	default:
		return "回写失败：" + err.Error()
	}
}

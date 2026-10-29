package board

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/i18n"
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
			return i18n.HelperError(fmt.Errorf("%s", strings.TrimSpace(stderr.buffer.String())))
		}
		return err
	}
	return nil
}

// StorageHelperText translates only known helper diagnostics. Unknown output,
// filenames, connection names, and other user data remain unchanged.
func StorageHelperText(locale i18n.Locale, text string) string {
	if result, ok := storageResponseMessage(locale, text); ok {
		return result
	}
	for legacy, key := range i18n.StorageHelperLegacy {
		english := (i18n.Message{Key: key}).Render(i18n.English)
		if text == legacy || text == english {
			return (i18n.Message{Key: key}).Render(locale)
		}
		if strings.HasSuffix(legacy, "：") || strings.HasSuffix(english, ": ") {
			for _, prefix := range []string{legacy, english} {
				if detail, ok := strings.CutPrefix(text, prefix); ok {
					return (i18n.Message{Key: key}).Render(locale) + StorageHelperText(locale, detail)
				}
			}
		}
	}
	return i18n.HelperText(locale, text)
}

func storageHelperError(err error) error {
	if err == nil {
		return nil
	}
	// Service.helper adds context before the feature sees the process error.
	// Translate its diagnostic argument while preserving that context and cause.
	var contextual *i18n.Error
	if errors.As(err, &contextual) && contextual.Message.Key == "common.operationFailed" {
		if reason, ok := contextual.Message.Args["reason"].(error); ok {
			return i18n.Wrap(err, contextual.Message.Key, map[string]any{"reason": storageHelperError(reason)})
		}
	}
	text := strings.TrimPrefix(err.Error(), "sudo: ")
	for legacy, key := range i18n.StorageHelperLegacy {
		if text == legacy || text == (i18n.Message{Key: key}).Render(i18n.English) {
			return i18n.Wrap(err, key, nil)
		}
		english := (i18n.Message{Key: key}).Render(i18n.English)
		if strings.HasSuffix(legacy, "：") || strings.HasSuffix(english, ": ") {
			for _, prefix := range []string{legacy, english} {
				if detail, ok := strings.CutPrefix(text, prefix); ok {
					return i18n.Wrap(err, "storage.helperDetail", map[string]any{"message": i18n.Message{Key: key}, "detail": storageHelperError(errors.New(detail))})
				}
			}
		}
	}
	return i18n.HelperError(err)
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
		return nil, i18n.New("disk.invalidResponse", nil)
	}
	return json.RawMessage(data.Bytes()), nil
}

func (s *Service) diskStream(ctx context.Context, input io.Reader, output io.Writer, args ...string) error {
	run := s.Stream
	if run == nil {
		run = ExecStream
	}
	return storageHelperError(run(ctx, input, output, "sudo", append([]string{"-n", Helper}, args...)...))
}

func (s *Service) UploadDiskFile(ctx context.Context, disk, path string, size int64, overwrite bool, input io.Reader) error {
	if size < 0 || size > 1<<32-1 {
		return i18n.New("disk.contentLength", nil)
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

var storageResponseKeys = []string{
	"storage.unsupported",
	"storage.invalidParameters",
	"storage.failedPrivate",
	"storage.busy",
	"storage.invalidResponse",
	"disk.invalidResponse",
	"disk.contentLength",
	"nasDisk.space",
	"nasDisk.timezone",
	"nasDisk.unsupported",
	"nasDisk.missingSession",
	"nasDisk.busy",
	"nasDisk.invalidResponse",
	"nasDisk.writebackStarted",
	"nasDisk.fuseUnavailable",
	"nasDisk.mountFailed",
	"nasDisk.checkRequired",
	"nasDisk.unsafeFilesystem",
	"nasDisk.stalled",
	"nasDisk.ejectRequired",
	"nasDisk.sessionChanged",
	"nasDisk.sessionBusy",
	"nasDisk.invalidOperation",
	"nasDisk.confirmSession",
	"nasDisk.operationUnsupported",
	"nasDisk.noFilesystem",
	"nasDisk.directoryConflict",
	"nasDisk.fileConflict",
	"disk.confirmName",
	"disk.uploadHeaders",
	"disk.missingLength",
	"disk.overwriteValue",
	"media.readFailed",
	"media.invalidList",
	"nasDisk.readSource",
	"nasDisk.full",
	"nasDisk.permission",
	"nasDisk.unreachable",
	"nasDisk.readFailed",
	"nasDisk.parseFailed",
	"nasDisk.cancelled",
	"nasDisk.writebackFailed",
}

// StorageJSONLocale translates manager-owned diagnostic fields while preserving
// user names, paths, numeric values, and the existing JSON response shape.
func StorageJSONLocale(data json.RawMessage, locale i18n.Locale) json.RawMessage {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if decoder.Decode(&value) != nil {
		return data
	}
	var visit func(any)
	visit = func(value any) {
		switch object := value.(type) {
		case map[string]any:
			for key, child := range object {
				if text, ok := child.(string); ok && (key == "error" || key == "reason" || key == "message") {
					object[key] = StorageHelperText(locale, text)
				} else {
					visit(child)
				}
			}
		case []any:
			for _, child := range object {
				visit(child)
			}
		}
	}
	visit(value)
	result, err := json.Marshal(value)
	if err != nil {
		return data
	}
	return result
}

func storageResponseMessage(locale i18n.Locale, text string) (string, bool) {
	token := regexp.MustCompile(`\{([A-Za-z0-9]+)\}`)
	for _, key := range storageResponseKeys {
		for _, sourceLocale := range []i18n.Locale{i18n.English, i18n.Chinese} {
			template := (i18n.Message{Key: key}).Render(sourceLocale)
			if text == template {
				return (i18n.Message{Key: key}).Render(locale), true
			}
			matches := token.FindAllStringSubmatchIndex(template, -1)
			if len(matches) == 0 {
				if strings.HasSuffix(template, ": ") || strings.HasSuffix(template, "：") {
					if detail, ok := strings.CutPrefix(text, template); ok {
						return (i18n.Message{Key: key}).Render(locale) + StorageHelperText(locale, detail), true
					}
				}
				continue
			}
			pattern := "(?s)^"
			position := 0
			names := []string{}
			for _, match := range matches {
				pattern += regexp.QuoteMeta(template[position:match[0]]) + "(.*?)"
				names = append(names, template[match[2]:match[3]])
				position = match[1]
			}
			pattern += regexp.QuoteMeta(template[position:]) + "$"
			if values := regexp.MustCompile(pattern).FindStringSubmatch(text); values != nil {
				args := map[string]any{}
				for index, name := range names {
					switch key {
					case "nasDisk.readSource", "nasDisk.fileConflict", "nasDisk.directoryConflict":
						// These arguments are user paths, not nested diagnostics.
						args[name] = values[index+1]
					default:
						args[name] = StorageHelperText(locale, values[index+1])
					}
				}
				return (i18n.Message{Key: key, Args: args}).Render(locale), true
			}
		}
	}
	return "", false
}

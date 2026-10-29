package i18n

import (
	"errors"
	"testing"
)

func TestLegacyHelperCompatibility(t *testing.T) {
	for original, key := range legacyHelperKeys {
		for _, text := range []string{original, en[key], "sudo: " + original} {
			cause := errors.New(text)
			err := HelperError(cause)
			if !errors.Is(err, cause) {
				t.Fatalf("%s: lost cause", key)
			}
			if err.Error() != en[key] {
				t.Errorf("%s: logs = %q", key, err)
			}
			if got := RenderError(Chinese, err); got != zhCN[key] {
				t.Errorf("%s: Chinese = %q", key, got)
			}
		}
	}
	unknown := errors.New("unexpected helper diagnostic")
	if HelperError(unknown) != unknown || HelperText(Chinese, unknown.Error()) != unknown.Error() {
		t.Fatal("unknown helper text must pass through unchanged")
	}
	checksum := HelperError(errors.New("内核文件校验失败：Image"))
	if checksum.Error() != "Kernel checksum verification failed: Image" {
		t.Fatal(checksum)
	}
	if RenderError(Chinese, checksum) != "内核文件校验失败：Image" {
		t.Fatal("lost checksum filename")
	}
}

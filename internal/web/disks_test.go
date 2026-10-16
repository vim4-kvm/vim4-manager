package web

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/vim4-kvm/vim4-manager/internal/board"
)

func TestDiskConfirmationAndFormatSnapshot(t *testing.T) {
	var calls [][]string
	s := &board.Service{Stream: func(_ context.Context, _ io.Reader, out io.Writer, _ string, args ...string) error {
		calls = append(calls, args[2:])
		_, err := io.WriteString(out, `{"ok":true}`)
		return err
	}}
	h := Handler(s, fstest.MapFS{})
	for _, test := range []struct{ endpoint, body string }{
		{"delete", `{"name":"disk.img","confirm":"wrong"}`},
		{"format", `{"name":"disk.img","label":"NEW"}`},
		{"resize", `{"name":"disk.img","sizeMiB":128,"confirm":"wrong"}`},
		{"restore", `{"disk":"disk.img","id":"snapshot","confirm":"other.img"}`},
	} {
		r := httptest.NewRequest("POST", "/api/disks/"+test.endpoint, strings.NewReader(test.body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatalf("confirmation accepted: %d", w.Code)
		}
	}
	if len(calls) != 0 {
		t.Fatal("unconfirmed request reached helper")
	}
	r := httptest.NewRequest("POST", "/api/disks/format", strings.NewReader(`{"name":"disk.img","confirm":"disk.img","label":"NEW","snapshot":true}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || len(calls) != 1 || strings.Join(calls[0], " ") != "disk-format disk.img NEW 1" {
		t.Fatalf("snapshot and format must share one helper lock: %d %v", w.Code, calls)
	}
	r = httptest.NewRequest("POST", "/api/disks/resize", strings.NewReader(`{"name":"disk.img","confirm":"disk.img","sizeMiB":128}`))
	r.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || len(calls) != 2 || strings.Join(calls[1], " ") != "disk-resize disk.img 128" {
		t.Fatalf("resize dispatch failed: %d %v", w.Code, calls)
	}
}

func TestDiskUploadRequiresPreflightHeadersAndLength(t *testing.T) {
	called := false
	s := &board.Service{Stream: func(_ context.Context, in io.Reader, _ io.Writer, _ string, args ...string) error {
		called = true
		data, err := io.ReadAll(in)
		if string(data) != "data" || args[len(args)-1] != "1" {
			t.Errorf("bad upload %q %v", data, args)
		}
		return err
	}}
	h := Handler(s, fstest.MapFS{})
	for _, test := range []struct {
		contentType, header, mode string
		size                      int64
		want                      int
	}{
		{"application/octet-stream", "", "1", 4, 415},
		{"text/plain", "1", "1", 4, 415},
		{"application/octet-stream", "1", "1", -1, 411},
		{"application/octet-stream", "1", "1", 0, 411},
		{"application/octet-stream", "1", "bad", 4, 400},
		{"application/octet-stream", "1", "1", 1 << 32, 400},
		{"application/octet-stream", "1", "1", 4, 200},
	} {
		called = false
		r := httptest.NewRequest("PUT", "/api/disks/file?disk=disk.img&path=/file&overwrite="+test.mode, strings.NewReader("data"))
		r.Header.Set("Content-Type", test.contentType)
		r.Header.Set("X-Vim4-Upload", test.header)
		r.ContentLength = test.size
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != test.want || called != (test.want == 200) {
			t.Fatalf("got %d called=%v for %+v", w.Code, called, test)
		}
	}
}

func TestDiskDownloadsBinaryAndJSONErrors(t *testing.T) {
	failure := false
	s := &board.Service{Stream: func(_ context.Context, _ io.Reader, out io.Writer, _ string, args ...string) error {
		if failure {
			return errors.New("数据盘正在使用")
		}
		_, err := out.Write([]byte{0, 255, 1})
		return err
	}}
	h := Handler(s, fstest.MapFS{})
	for _, endpoint := range []string{"file?disk=disk.img&path=/%E4%B8%AD%20a.txt", "image?disk=disk.img"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "/api/disks/"+endpoint, nil))
		if w.Code != 200 || w.Body.String() != string([]byte{0, 255, 1}) || !strings.Contains(w.Header().Get("Content-Disposition"), "filename*=UTF-8''") {
			t.Fatalf("bad download: %v %q", w.Result().Header, w.Body.String())
		}
		if strings.HasPrefix(endpoint, "file") && !strings.Contains(w.Header().Get("Content-Disposition"), "%E4%B8%AD%20a.txt") {
			t.Fatal("filename not RFC 5987 encoded")
		}
	}
	failure = true
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/api/disks/image?disk=disk.img", nil))
	if w.Code != http.StatusBadRequest || w.Header().Get("Content-Type") != "application/json" || !strings.Contains(w.Body.String(), "error") {
		t.Fatalf("expected JSON failure before streaming: %d %s", w.Code, w.Body.String())
	}
}

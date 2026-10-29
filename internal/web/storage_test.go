package web

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/vim4-kvm/vim4-manager/internal/board"
)

func TestStorageHTTPDiagnosticLocale(t *testing.T) {
	service := &board.Service{Stream: func(_ context.Context, _ io.Reader, out io.Writer, _ string, _ ...string) error {
		_, err := io.WriteString(out, `{"name":"文件夹","error":"没有找到共享","session":{"error":"会话已改变"}}`)
		return err
	}}
	handler := Handler(service, fstest.MapFS{})
	for _, endpoint := range []struct{ method, path string }{
		{"GET", "/api/storage"}, {"GET", "/api/storage/dirs?id=nas"},
		{"POST", "/api/storage/test"}, {"GET", "/api/nasdisk"}, {"POST", "/api/nasdisk/commit"},
	} {
		for _, locale := range []string{"en", "zh-CN"} {
			r := httptest.NewRequest(endpoint.method, endpoint.path, strings.NewReader(`{"id":"nas-1"}`))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Cookie", "vim4_lang="+locale)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			var value struct {
				Name, Error string
				Session     struct{ Error string }
			}
			if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
				t.Fatal(err)
			}
			want := "The session has changed. Refresh and try again."
			if locale == "zh-CN" {
				want = "会话已改变"
			}
			if w.Code != 200 || value.Name != "文件夹" || value.Session.Error != want {
				t.Fatalf("%s %s: %d %s", endpoint.path, locale, w.Code, w.Body.String())
			}
		}
	}
}

func TestStorageRoutes(t *testing.T) {
	for _, test := range []struct{ method, url, body, command string }{
		{"GET", "/api/storage", "", "storage-list"},
		{"GET", "/api/storage/dirs?id=nas&path=%2Ffolder", "", "storage-dirs nas /folder"},
		{"POST", "/api/storage", `{"name":"NAS","password":"secret"}`, "storage-save"},
		{"POST", "/api/storage/test", `{"id":"nas","password":"secret"}`, "storage-test"},
		{"POST", "/api/storage/mkdir", `{"id":"nas","path":"/parent","name":"新目录"}`, "storage-mkdir"},
		{"POST", "/api/storage/mount", `{"id":"nas"}`, "storage-mount nas"},
		{"POST", "/api/storage/unmount", `{"id":"nas"}`, "storage-unmount nas"},
		{"POST", "/api/storage/delete", `{"id":"nas","confirm":"NAS"}`, "storage-delete nas"},
	} {
		t.Run(test.command, func(t *testing.T) {
			s := &board.Service{Stream: func(_ context.Context, in io.Reader, out io.Writer, _ string, args ...string) error {
				if strings.Join(args[2:], " ") != test.command {
					t.Fatalf("wrong arguments %v", args)
				}
				if test.method == "POST" {
					var got, want map[string]any
					_ = json.Unmarshal([]byte(test.body), &want)
					if err := json.NewDecoder(in).Decode(&got); err != nil {
						t.Fatal(err)
					}
					for key, value := range want {
						if got[key] != value {
							t.Fatalf("field %s not forwarded", key)
						}
					}
				}
				_, err := io.WriteString(out, `{"ok":true}`)
				return err
			}}
			r := httptest.NewRequest(test.method, test.url, strings.NewReader(test.body))
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			Handler(s, fstest.MapFS{}).ServeHTTP(w, r)
			if w.Code != 200 {
				t.Fatalf("status %d: %s", w.Code, w.Body)
			}
		})
	}
}

func TestStorageFailureAndAccessBoundary(t *testing.T) {
	called := false
	failure := errors.New("权限被拒")
	s := &board.Service{Stream: func(context.Context, io.Reader, io.Writer, string, ...string) error {
		called = true
		return failure
	}}
	h := Handler(s, fstest.MapFS{})
	for _, test := range []struct {
		method, endpoint, contentType, origin, peer string
		status                                      int
		invokes                                     bool
	}{
		{"GET", "/api/storage", "", "", "192.168.1.2:100", 200, true},
		{"POST", "/api/storage/mount", "application/json", "", "192.168.1.2:100", 400, true},
		{"POST", "/api/storage/mkdir", "application/json", "", "192.168.1.2:100", 400, true},
		{"POST", "/api/storage", "text/plain", "", "192.168.1.2:100", 415, false},
		{"POST", "/api/storage", "application/json", "http://evil.invalid", "192.168.1.2:100", 403, false},
		{"POST", "/api/storage", "application/json", "", "100.64.0.1:100", 400, true},
	} {
		called = false
		r := httptest.NewRequest(test.method, test.endpoint, strings.NewReader(`{"id":"nas"}`))
		r.Header.Set("Content-Type", test.contentType)
		r.Header.Set("Origin", test.origin)
		r.RemoteAddr = test.peer
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != test.status || called != test.invokes {
			t.Fatalf("status %d called=%v for %+v", w.Code, called, test)
		}
		if test.method == "GET" && !strings.Contains(w.Body.String(), `"known":false`) {
			t.Fatal("failure reported as known")
		}
	}
	failure = board.ErrBusy
	r := httptest.NewRequest("POST", "/api/storage/mount", strings.NewReader(`{"id":"nas"}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 409 {
		t.Fatalf("busy status %d", w.Code)
	}
}

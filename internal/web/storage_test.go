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

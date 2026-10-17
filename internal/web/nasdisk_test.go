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

func TestNASDiskRoutes(t *testing.T) {
	for _, test := range []struct{ method, url, body, command string }{
		{"GET", "/api/nasdisk", "", "nasdisk-status"},
		{"POST", "/api/nasdisk/start", `{"storage":"nas","path":"/folder","mode":"rw","label":"FILES","utcOffsetMinutes":480}`, "nasdisk-start"},
		{"POST", "/api/nasdisk/start", `{"storage":"nas","path":"/","mode":"ro","utcOffsetMinutes":0}`, "nasdisk-start"},
		{"POST", "/api/nasdisk/cancel", `{}`, "nasdisk-cancel"},
		{"POST", "/api/nasdisk/commit", `{"id":"session","force":true}`, "nasdisk-commit session force"},
		{"POST", "/api/nasdisk/reattach", `{"id":"session"}`, "nasdisk-reattach session"},
		{"POST", "/api/nasdisk/discard", `{"id":"session","confirm":"session"}`, "nasdisk-discard session"},
		{"POST", "/api/nasdisk/trash-empty", `{"id":"session","confirm":"session"}`, "nasdisk-trash-empty"},
	} {
		t.Run(test.command, func(t *testing.T) {
			s := &board.Service{Stream: func(_ context.Context, in io.Reader, out io.Writer, _ string, args ...string) error {
				if strings.Join(args[2:], " ") != test.command {
					t.Fatalf("arguments %v", args)
				}
				if test.method == "POST" {
					var got, want map[string]any
					if err := json.NewDecoder(in).Decode(&got); err != nil {
						t.Fatal(err)
					}
					json.Unmarshal([]byte(test.body), &want)
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
				t.Fatalf("%d %s", w.Code, w.Body)
			}
		})
	}
}

func TestNASDiskAccessAndFailure(t *testing.T) {
	called := false
	s := &board.Service{Stream: func(context.Context, io.Reader, io.Writer, string, ...string) error {
		called = true
		return errors.New("另一个 NAS U 盘操作正在进行，请稍后重试")
	}}
	for _, test := range []struct {
		method, endpoint, content, origin, peer string
		code                                    int
		calls                                   bool
	}{
		{"GET", "/api/nasdisk", "", "", "192.168.1.2:100", 200, true},
		{"POST", "/api/nasdisk/cancel", "application/json", "", "192.168.1.2:100", 409, true},
		{"POST", "/api/nasdisk/trash-empty", "application/json", "", "192.168.1.2:100", 409, true},
		{"POST", "/api/nasdisk/start", "text/plain", "", "192.168.1.2:100", 415, false},
		{"POST", "/api/nasdisk/start", "application/json", "http://evil.invalid", "192.168.1.2:100", 403, false},
		{"POST", "/api/nasdisk/start", "application/json", "", "100.64.0.1:100", 403, false},
	} {
		called = false
		r := httptest.NewRequest(test.method, test.endpoint, strings.NewReader(`{}`))
		r.Header.Set("Content-Type", test.content)
		r.Header.Set("Origin", test.origin)
		r.RemoteAddr = test.peer
		w := httptest.NewRecorder()
		Handler(s, fstest.MapFS{}).ServeHTTP(w, r)
		if w.Code != test.code || called != test.calls {
			t.Fatalf("%+v: %d called=%v", test, w.Code, called)
		}
		if test.method == "GET" && !strings.Contains(w.Body.String(), `"known":false`) {
			t.Fatal(w.Body)
		}
	}
}

func TestNASDiskStartRejectsInvalidTimezone(t *testing.T) {
	for _, offset := range []string{"-721", "841", "1.5", `"480"`, "true"} {
		t.Run(offset, func(t *testing.T) {
			called := false
			service := &board.Service{Stream: func(context.Context, io.Reader, io.Writer, string, ...string) error {
				called = true
				return nil
			}}
			request := httptest.NewRequest("POST", "/api/nasdisk/start", strings.NewReader(`{"storage":"nas","path":"/","mode":"rw","utcOffsetMinutes":`+offset+`}`))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			Handler(service, fstest.MapFS{}).ServeHTTP(response, request)
			if response.Code != 400 || called {
				t.Fatalf("invalid offset reached helper: status=%d called=%v", response.Code, called)
			}
		})
	}
}

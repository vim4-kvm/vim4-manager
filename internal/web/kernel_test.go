package web

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/vim4-kvm/vim4-manager/internal/board"
)

func TestKernelSelectionBoundary(t *testing.T) {
	for _, tc := range []struct {
		body   string
		status int
		args   string
	}{
		{`{"id":"mainline","reboot":true}`, 200, "kernel-select mainline true"},
		{`{"id":"vendor","reboot":false}`, 200, "kernel-select vendor false"},
		{`{"id":"vendor;reboot","reboot":true}`, 400, ""},
		{`{"id":"mainline","reboot":"yes"}`, 400, ""},
		{`{}`, 400, ""},
	} {
		t.Run(tc.body, func(t *testing.T) {
			var got string
			s := &board.Service{Run: func(_ context.Context, name string, args ...string) (string, error) {
				got = strings.Join(append([]string{name}, args...), " ")
				return "", nil
			}}
			r := httptest.NewRequest(http.MethodPost, "/api/kernel", strings.NewReader(tc.body))
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			Handler(s, fstest.MapFS{}).ServeHTTP(w, r)
			want := ""
			if tc.args != "" {
				want = "sudo -n " + board.Helper + " " + tc.args
			}
			if w.Code != tc.status || got != want {
				t.Fatalf("status %d command %q", w.Code, got)
			}
		})
	}
}

func TestKernelInventoryFailureIsVisible(t *testing.T) {
	s := &board.Service{Run: func(context.Context, string, ...string) (string, error) {
		return "", errors.New("installation manifest missing")
	}}
	w := httptest.NewRecorder()
	Handler(s, fstest.MapFS{}).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/kernel", nil))
	if w.Code != 500 || !strings.Contains(w.Body.String(), "manifest missing") {
		t.Fatal(w.Code, w.Body.String())
	}
}

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

func TestEDIDRequests(t *testing.T) {
	for _, tc := range []struct {
		body   string
		want   int
		called bool
	}{
		{`{"id":"RTK-CONTROL"}`, 200, true},
		{`{"id":"../../etc/passwd"}`, 400, false},
		{`{}`, 400, false},
		{`broken`, 400, false},
	} {
		t.Run(tc.body, func(t *testing.T) {
			called := false
			s := &board.Service{Run: func(ctx context.Context, name string, args ...string) (string, error) {
				called = true
				if name != "sudo" || strings.Join(args, " ") != "-n "+board.Helper+" edid-select RTK-CONTROL" {
					t.Fatalf("unexpected command: %s %v", name, args)
				}
				return "", nil
			}}
			h := Handler(s, fstest.MapFS{})
			r := httptest.NewRequest(http.MethodPost, "/api/edid", strings.NewReader(tc.body))
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.want || called != tc.called {
				t.Fatalf("status=%d called=%v", w.Code, called)
			}
		})
	}
}

func TestEDIDReadFailureDoesNotReturnEmptySuccess(t *testing.T) {
	s := &board.Service{Run: func(context.Context, string, ...string) (string, error) {
		return "", errors.New("catalog missing")
	}}
	w := httptest.NewRecorder()
	Handler(s, fstest.MapFS{}).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/edid", nil))
	if w.Code != 500 || !strings.Contains(w.Body.String(), "catalog missing") {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}

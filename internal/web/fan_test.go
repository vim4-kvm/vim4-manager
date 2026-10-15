package web

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/vim4-kvm/vim4-manager/internal/board"
)

func TestFanCurveRequests(t *testing.T) {
	for _, tc := range []struct {
		body string
		want int
		args string
	}{
		{`{"low":55,"mid":75,"high":95}`, 200, "fan-curve 55 75 95"},
		{`{"low":35,"mid":40,"high":45}`, 200, "fan-curve 35 40 45"},
		{`{"low":34,"mid":75,"high":95}`, 400, ""},
		{`{"low":60,"mid":64,"high":95}`, 400, ""},
		{`{"low":60,"mid":80,"high":84}`, 400, ""},
		{`{"low":60,"mid":80,"high":101}`, 400, ""},
		{`{}`, 400, ""},
		{`broken`, 400, ""},
	} {
		t.Run(tc.body, func(t *testing.T) {
			var got string
			s := &board.Service{Run: func(ctx context.Context, name string, args ...string) (string, error) {
				got = strings.Join(append([]string{name}, args...), " ")
				return "", nil
			}}
			request := httptest.NewRequest(http.MethodPost, "/api/fan-curve", strings.NewReader(tc.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			Handler(s, fstest.MapFS{}).ServeHTTP(response, request)
			want := ""
			if tc.args != "" {
				want = "sudo -n " + board.Helper + " " + tc.args
			}
			if response.Code != tc.want || got != want {
				t.Errorf("status %d, ran %q", response.Code, got)
			}
		})
	}
}

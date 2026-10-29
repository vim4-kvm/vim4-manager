package web

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/vim4-kvm/vim4-manager/internal/board"
)

func TestGatewayLocalizedUnavailable(t *testing.T) {
	for _, test := range []struct{ locale, text string }{
		{"en", "The KVM interface isn't running"},
		{"zh-CN", "KVM 界面未运行"},
	} {
		for _, accept := range []string{"application/json", "text/html"} {
			r := httptest.NewRequest("GET", "http://localhost:8080/", nil)
			r.Header.Set("Accept", accept)
			r.Header.Set("Cookie", "vim4_lang="+test.locale)
			w := httptest.NewRecorder()
			kvmUnavailable(w, r, nil)
			body := w.Body.String()
			if accept == "text/html" {
				body = strings.ReplaceAll(body, "&#39;", "'")
			}
			if w.Code != http.StatusBadGateway || !strings.Contains(body, test.text) {
				t.Fatalf("%s %s: %d %s", test.locale, accept, w.Code, body)
			}
			if accept == "text/html" && !strings.Contains(body, `lang="`+test.locale+`"`) {
				t.Fatal("incorrect html lang")
			}
		}
	}
}

func TestStatusRendersRecordedActionsForEachRequestLocale(t *testing.T) {
	service := &board.Service{Root: t.TempDir(), Events: &board.Events{Capacity: 10}}
	service.Run = func(_ context.Context, name string, args ...string) (string, error) {
		if name != "systemctl" {
			return "", nil
		}
		var output strings.Builder
		for _, arg := range args {
			if strings.HasSuffix(arg, ".service") {
				output.WriteString("Id=" + arg + "\nLoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=disabled\n\n")
			}
		}
		return output.String(), nil
	}
	if err := service.Restart(context.Background(), "vim4-kvm-hdmi.service"); err != nil {
		t.Fatal(err)
	}
	handler := Handler(service, fstest.MapFS{})
	var eventTime int64
	for _, test := range []struct{ locale, event, label string }{
		{"en", "Restart HDMI capture", "HDMI capture"},
		{"zh-CN", "重启HDMI 采集", "HDMI 采集"},
		{"en", "Restart HDMI capture", "HDMI capture"},
	} {
		request := httptest.NewRequest(http.MethodGet, "/api/status", nil)
		request.AddCookie(&http.Cookie{Name: "vim4_lang", Value: test.locale})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		var status board.Status
		if err := json.Unmarshal(response.Body.Bytes(), &status); err != nil {
			t.Fatal(err)
		}
		if response.Code != http.StatusOK || len(status.Events) != 1 || status.Events[0].Text != test.event || status.Platform[0].Name != test.label {
			t.Fatalf("%s: %d %s", test.locale, response.Code, response.Body.String())
		}
		if eventTime != 0 && status.Events[0].UnixMs != eventTime {
			t.Fatal("request-time translation changed the recorded event identity")
		}
		eventTime = status.Events[0].UnixMs
	}
}

package web

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/vim4-kvm/vim4-manager/internal/board"
)

type fakePassthrough struct {
	state    board.PassthroughState
	err      error
	writeErr error
}

func (f *fakePassthrough) Status(context.Context) (board.PassthroughState, error) {
	return f.state, f.err
}

func (f *fakePassthrough) Apply(_ context.Context, prefs board.PassthroughPreferences) (board.PassthroughState, error) {
	if f.writeErr != nil {
		return f.state, f.writeErr
	}
	f.state.Enabled, f.state.Audio = prefs.Enabled, prefs.Audio
	f.state.State = "no-signal"
	return f.state, f.err
}

func TestPassthroughAPI(t *testing.T) {
	fake := &fakePassthrough{state: board.PassthroughState{Supported: true, State: "off"}}
	p, err := board.OpenPassthrough(context.Background(), t.TempDir(), fake, nil)
	if err != nil {
		t.Fatal(err)
	}
	h := Handler(&board.Service{Passthrough: p}, fstest.MapFS{})
	for _, tc := range []struct {
		method string
		body   string
		code   int
	}{
		{"GET", "", 200},
		{"POST", `{"enabled":true,"audio":true}`, 200},
		{"GET", "", 200},
		{"POST", `{}`, 400},
		{"POST", `{"enabled":"true"}`, 400},
		{"POST", `{"audio":1}`, 400},
		{"POST", `{"enabled":null}`, 400},
		{"POST", `broken`, 400},
	} {
		r := httptest.NewRequest(tc.method, "/api/passthrough", strings.NewReader(tc.body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.code {
			t.Fatalf("%s %s: %d %s", tc.method, tc.body, w.Code, w.Body.String())
		}
		if tc.code == 200 {
			var got board.PassthroughState
			if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || got != fake.state {
				t.Fatalf("not actual state: %+v %v", got, err)
			}
		}
	}
	fake.writeErr = errors.New("apply failed")
	r := httptest.NewRequest("POST", "/api/passthrough", strings.NewReader(`{"enabled":false}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 500 || !strings.Contains(w.Body.String(), "apply failed") {
		t.Fatalf("apply failure: %d %s", w.Code, w.Body.String())
	}
	fake.writeErr = nil
	fake.err = errors.New("read failed")
	for _, method := range []string{"GET", "POST"} {
		r := httptest.NewRequest(method, "/api/passthrough", strings.NewReader(`{"enabled":true}`))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 500 || !strings.Contains(w.Body.String(), "read failed") {
			t.Fatalf("failure: %d %s", w.Code, w.Body.String())
		}
	}
}

func TestPassthroughAPIUnsupported(t *testing.T) {
	provider := &fakePassthrough{state: board.PassthroughState{State: "unsupported"}}
	passthrough, err := board.OpenPassthrough(context.Background(), t.TempDir(), provider, nil)
	if err != nil {
		t.Fatal(err)
	}
	h := Handler(&board.Service{Passthrough: passthrough}, fstest.MapFS{})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/api/passthrough", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"supported":false`) || !strings.Contains(w.Body.String(), `"state":"unsupported"`) {
		t.Fatalf("unsupported GET: %d %s", w.Code, w.Body.String())
	}
	r := httptest.NewRequest("POST", "/api/passthrough", strings.NewReader(`{"enabled":true}`))
	r.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "当前内核不支持") {
		t.Fatalf("unsupported POST: %d %s", w.Code, w.Body.String())
	}
}

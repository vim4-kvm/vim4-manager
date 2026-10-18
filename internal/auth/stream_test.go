package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/synctest"
	"time"
)

// Virtual time exercises the lease held by a blocking proxy handler without
// sleeping for a minute or changing the production renewal interval.
func TestActiveRequestRenewsUntilAbsoluteExpiry(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := store(t)
		token := setup(t, s)
		s.mu.Lock()
		s.sessions[digest(token)].Created = time.Now().Add(-24*time.Hour + 2*time.Minute)
		s.mu.Unlock()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		r := httptest.NewRequest("GET", "/stream", nil).WithContext(ctx)
		r.RemoteAddr = "127.0.0.1:1234"
		r.AddCookie(&http.Cookie{Name: CookieName, Value: token})
		done := make(chan struct{})
		handler := s.Require(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			<-r.Context().Done()
		}))
		go func() {
			defer close(done)
			handler.ServeHTTP(httptest.NewRecorder(), r)
		}()
		synctest.Wait()
		before := s.Sessions()[0].LastActive
		time.Sleep(time.Minute)
		synctest.Wait()
		if !s.Sessions()[0].LastActive.Equal(before.Add(time.Minute)) {
			t.Fatal("active proxy request did not renew its session")
		}
		select {
		case <-done:
			t.Fatal("request ended before absolute expiry")
		default:
		}
		time.Sleep(time.Minute)
		synctest.Wait()
		select {
		case <-done:
		default:
			t.Fatal("active request survived absolute expiry")
		}
	})
}

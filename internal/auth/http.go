package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"
)

const CookieName = "vim4_session"

type sessionKey struct{}

func Current(r *http.Request) *Session {
	v, _ := r.Context().Value(sessionKey{}).(*Session)
	return v
}

func response(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func failure(w http.ResponseWriter, e error) {
	code := 400
	var locked *LockedError
	switch {
	case errors.As(e, &locked):
		response(w, 429, map[string]any{"error": e.Error(), "retryAfter": locked.RetryAfter})
		return
	case errors.Is(e, ErrBusy), errors.Is(e, ErrUnavailable):
		code = 503
	case errors.Is(e, ErrCredentials):
		code = 401
	case errors.Is(e, ErrConfigured):
		code = 409
	}
	response(w, code, map[string]string{"error": e.Error()})
}

func (s *Store) cookie(w http.ResponseWriter, r *http.Request, token string) {
	age := 30 * 24 * 3600
	if token == "" {
		age = -1
	}
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   Secure(r),
		MaxAge:   age,
	})
}

func (s *Store) session(r *http.Request) *Session {
	c, e := r.Cookie(CookieName)
	if e != nil {
		return nil
	}
	return s.Authenticate(c.Value, Peer(r.RemoteAddr))
}

// Require preserves request values/deadlines and joins client cancellation with
// the session lifetime. Future proxy handlers use this same cancellation scope.
func (s *Store) Require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		v := s.session(r)
		if v == nil {
			response(w, 401, map[string]string{"error": "未登录"})
			return
		}
		ctx, cancel := context.WithCancel(r.Context())
		stop := context.AfterFunc(v.ctx, cancel)
		defer stop()
		defer cancel()
		if v.ctx.Err() != nil {
			cancel()
		}
		// Active streams count as activity, but still respect absolute expiry and
		// the source of this request when their lease is renewed.
		done := make(chan struct{})
		defer close(done)
		go func() {
			t := time.NewTicker(time.Minute)
			defer t.Stop()
			for {
				select {
				case <-done:
					return
				case <-ctx.Done():
					return
				case <-t.C:
					c, e := r.Cookie(CookieName)
					if e != nil || s.Authenticate(c.Value, Peer(r.RemoteAddr)) == nil {
						cancel()
						return
					}
				}
			}
		}()
		next.ServeHTTP(w, r.WithContext(context.WithValue(ctx, sessionKey{}, v)))
	})
}

// Routes is reusable on each listener. Host, same-origin and JSON checks belong
// outside this handler; account routes are registered only by the manager.
func (s *Store) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /__vim4/api/auth/state", func(w http.ResponseWriter, r *http.Request) {
		c := s.Credentials()
		v := s.session(r)
		retry, _ := s.limits.check(Peer(r.RemoteAddr), s.now())
		hostname, _ := os.Hostname()
		username := ""
		if v != nil {
			username = c.Username
		}
		response(w, 200, map[string]any{
			"configured":    s.Configured(),
			"authenticated": v != nil,
			"username":      username,
			"secure":        Secure(r),
			"setupAllowed":  LAN(Peer(r.RemoteAddr)),
			"retryAfter":    retry,
			"hostname":      hostname,
		})
	})
	for _, action := range []string{"login", "setup"} {
		mux.HandleFunc("POST /__vim4/api/auth/"+action, func(w http.ResponseWriter, r *http.Request) {
			var body struct {
				Username string `json:"username"`
				Password string `json:"password"`
			}
			if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body) != nil {
				failure(w, errors.New("请求格式错误"))
				return
			}
			if action == "setup" && !LAN(Peer(r.RemoteAddr)) {
				response(w, 403, map[string]string{"error": "请在局域网内完成首次设置"})
				return
			}
			var token string
			var e error
			if action == "setup" {
				token, e = s.Setup(r.Context(), Peer(r.RemoteAddr), r.UserAgent(), body.Username, body.Password)
			} else {
				token, e = s.Login(r.Context(), Peer(r.RemoteAddr), r.UserAgent(), body.Username, body.Password)
			}
			if e != nil {
				failure(w, e)
				return
			}
			s.cookie(w, r, token)
			response(w, 200, map[string]bool{"ok": true})
		})
	}
	mux.Handle("POST /__vim4/api/auth/logout", s.Require(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if e := s.Revoke(Current(r).ID, false); e != nil {
			failure(w, e)
			return
		}
		s.cookie(w, r, "")
		response(w, 200, map[string]bool{"ok": true})
	})))
	return mux
}

func (s *Store) AccountRoutes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/account/sessions", func(w http.ResponseWriter, r *http.Request) {
		rows := []map[string]any{}
		for _, v := range s.Sessions() {
			rows = append(rows, map[string]any{
				"id":         v.ID,
				"address":    v.Address,
				"userAgent":  v.UserAgent,
				"created":    v.Created,
				"lastActive": v.LastActive,
				"current":    v.ID == Current(r).ID,
			})
		}
		c := s.Credentials()
		response(w, 200, map[string]any{
			"username":        c.Username,
			"passwordChanged": c.PasswordChanged,
			"sessions":        rows,
		})
	})
	for _, action := range []string{"revoke", "logout-others", "password", "username"} {
		mux.HandleFunc("POST /api/account/"+action, func(w http.ResponseWriter, r *http.Request) {
			var body struct {
				ID              string `json:"id"`
				CurrentPassword string `json:"currentPassword"`
				Password        string `json:"password"`
				Username        string `json:"username"`
			}
			if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body) != nil {
				failure(w, errors.New("请求格式错误"))
				return
			}
			var e error
			switch action {
			case "revoke":
				e = s.Revoke(body.ID, false)
			case "logout-others":
				e = s.Revoke(Current(r).ID, true)
			case "password":
				e = s.Change(r.Context(), Peer(r.RemoteAddr), Current(r), body.CurrentPassword, "", body.Password)
			case "username":
				if strings.TrimSpace(body.Username) == "" {
					failure(w, errors.New("用户名不能为空"))
					return
				}
				e = s.Change(r.Context(), Peer(r.RemoteAddr), Current(r), body.CurrentPassword, body.Username, "")
			}
			if errors.Is(e, ErrCredentials) {
				response(w, 403, map[string]string{"error": "当前密码错误"})
				return
			}
			if e != nil {
				failure(w, e)
				return
			}
			response(w, 200, map[string]bool{"ok": true})
		})
	}
	return s.Require(mux)
}

package web

import (
	"context"
	"errors"
	"fmt"
	"html"
	"io/fs"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/auth"
	"github.com/vim4-kvm/vim4-manager/internal/board"
	"github.com/vim4-kvm/vim4-manager/internal/i18n"
)

// KVMHandler serves the application's unbounded streams and uploads. The
// manager's JSON/body limits must only apply inside the reserved auth namespace.
func KVMHandler(service *board.Service, assets fs.FS, sessions *auth.Store, backend string, allowedHosts []string) http.Handler {
	proxy := &httputil.ReverseProxy{
		FlushInterval: -1,
		Rewrite: func(p *httputil.ProxyRequest) {
			p.Out.URL.Scheme = "http"
			p.Out.URL.Host = backend
			p.Out.Host = p.In.Host
			for name := range p.Out.Header {
				key := strings.ToLower(name)
				if strings.HasPrefix(key, "x-forwarded-") || key == "forwarded" || key == "x-real-ip" || key == "x-kvmd-user" || key == "x-kvmd-passwd" || key == "authorization" {
					p.Out.Header.Del(name)
				}
			}
			if p.In.URL.Path == "/api/mcp" {
				p.Out.Header.Set("Authorization", p.In.Header.Get("Authorization"))
			}
			ip := auth.Peer(p.In.RemoteAddr)
			if ip.IsValid() {
				p.Out.Header.Set("X-Forwarded-For", ip.String())
				p.Out.Header.Set("X-Real-IP", ip.String())
			}
			p.Out.Header.Set("X-Forwarded-Proto", requestScheme(p.In))
			p.Out.Header.Del("Cookie")
			for _, cookie := range p.In.Cookies() {
				if cookie.Name != auth.CookieName {
					p.Out.AddCookie(cookie)
				}
			}
		},
		ModifyResponse: func(r *http.Response) error {
			for name := range r.Header {
				if strings.HasPrefix(strings.ToLower(name), "access-control-allow-") {
					r.Header.Del(name)
				}
			}
			return nil
		},
		ErrorHandler: kvmUnavailable,
	}
	forward := kvmOrigin(proxy)
	protected := sessions.Require(forward)
	login := AuthHandler(assets, sessions)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestPath := path.Clean(r.URL.Path)
		if strings.HasPrefix(requestPath, "/__vim4/") {
			// The shared login bundle defaults to the manager's overview. On
			// this listener, missing/unsafe next values must lead to the KVM root.
			if r.Method == http.MethodGet && requestPath == "/__vim4/login" && r.URL.Query().Get("next") != auth.Next(r.URL.Query().Get("next")) {
				http.Redirect(w, r, "/__vim4/login?next=%2F", http.StatusFound)
				return
			}
			login.ServeHTTP(w, r)
			return
		}
		if requestPath == "/redfish" || strings.HasPrefix(requestPath, "/redfish/") {
			http.NotFound(w, r)
			return
		}
		mcp := requestPath == "/api/mcp" || strings.HasPrefix(requestPath, "/api/mcp/")
		if mcp {
			app, err := service.SelectedApp(r.Context())
			if err != nil || (app != "nanokvm" && app != "onekvm") {
				writeLocalizedError(w, r, http.StatusUnauthorized, i18n.New("gateway.mcpUnavailable", nil))
				return
			}
			// Only the transport enforces a Bearer key. Its siblings expose
			// settings and key management through the application's web auth.
			if r.URL.Path == "/api/mcp" && sessions.Configured() {
				forward.ServeHTTP(w, r)
				return
			}
		}
		if !mcp && htmlRequest(r) {
			cookie, err := r.Cookie(auth.CookieName)
			if err != nil || sessions.Authenticate(cookie.Value, auth.Peer(r.RemoteAddr)) == nil {
				http.Redirect(w, r, "/__vim4/login?next="+url.QueryEscape(r.URL.RequestURI()), http.StatusFound)
				return
			}
		}
		protected.ServeHTTP(w, r)
	})
	return CheckHost(service, handler, allowedHosts)
}

func requestScheme(r *http.Request) string {
	if auth.Secure(r) {
		return "https"
	}
	return "http"
}

func websocketRequest(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

func htmlRequest(r *http.Request) bool {
	return r.Method == http.MethodGet && strings.Contains(r.Header.Get("Accept"), "text/html") && !websocketRequest(r)
}

func kvmOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !readRequest(r.Method) || websocketRequest(r) {
			if values, present := r.Header["Origin"]; present {
				u, err := url.Parse(r.Header.Get("Origin"))
				if len(values) != 1 || err != nil || u.Scheme != requestScheme(r) || !strings.EqualFold(u.Host, r.Host) || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
					writeLocalizedError(w, r, http.StatusForbidden, i18n.New("access.crossSite", nil))
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

func kvmUnavailable(w http.ResponseWriter, r *http.Request, _ error) {
	if !htmlRequest(r) {
		writeLocalizedError(w, r, http.StatusBadGateway, i18n.New("gateway.unavailable", nil))
		return
	}
	host := r.Host
	if name, _, err := net.SplitHostPort(host); err == nil {
		host = name
	}
	if strings.Contains(host, ":") {
		host = "[" + strings.Trim(host, "[]") + "]"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusBadGateway)
	locale := i18n.RequestLocale(r)
	_, _ = fmt.Fprintf(w, `<!doctype html><html lang="%s"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VIM4 KVM</title>
<style>:root{color-scheme:light;--page:#f4f5f7;--surface:#fff;--ink:#1d2025;--rule:#e6e8eb;--accent-ink:#005bd1}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--page:#121315;--surface:#1c1d21;--ink:#e9eaec;--rule:#2a2c31;--accent-ink:#6aa6ff}}body{margin:0;background:var(--page);color:var(--ink);font:14px/1.55 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}main{box-sizing:border-box;width:min(360px,calc(100%% - 32px));padding:24px;background:var(--surface);border:1px solid var(--rule);border-radius:10px}a{color:var(--accent-ink)}</style>
<main><h1>VIM4 KVM</h1><p>%s</p><a href="http://%s/#/apps">%s</a></main></html>`, locale,
		html.EscapeString(i18n.Message{Key: "gateway.unavailable"}.Render(locale)), html.EscapeString(host),
		html.EscapeString(i18n.Message{Key: "gateway.openManager"}.Render(locale)))
}

// ServeKVM retries a legacy application's occupied port without delaying the
// manager listener. The context also closes upgraded connections on shutdown.
func ServeKVM(ctx context.Context, address string, handler http.Handler, events *board.Events) error {
	server := &http.Server{Addr: address, Handler: handler, ReadHeaderTimeout: 10 * time.Second,
		BaseContext: func(net.Listener) context.Context { return ctx }}
	waiting := false
	for {
		if ctx.Err() != nil {
			return nil
		}
		listener, err := net.Listen("tcp", address)
		if err == nil {
			defer listener.Close()
			events.AddMessage("good", i18n.Message{Key: "events.gatewayStarted"})
			stop := context.AfterFunc(ctx, func() { _ = server.Close() })
			defer stop()
			err = server.Serve(listener)
			if errors.Is(err, http.ErrServerClosed) {
				return nil
			}
			return err
		}
		if !waiting {
			events.AddMessage("warning", i18n.Message{Key: "events.gatewayWaiting"})
			waiting = true
		}
		timer := time.NewTimer(2 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
	}
}

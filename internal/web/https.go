package web

import (
	"context"
	"net"
	"net/http"
	"strings"

	"github.com/vim4-kvm/vim4-manager/internal/auth"
	"github.com/vim4-kvm/vim4-manager/internal/board"
)

func httpsRoutes(mux *http.ServeMux, service *board.Service, sessions *auth.Store) {
	api := http.NewServeMux()
	api.HandleFunc("GET /__vim4/api/https", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, service.HTTPS.Status(r.TLS != nil))
	})
	api.HandleFunc("PUT /__vim4/api/https", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Enabled *bool `json:"http_enabled"`
		}
		if !decode(w, r, &request) {
			return
		}
		if request.Enabled == nil {
			writeJSON(w, 400, map[string]string{"error": "http_enabled is required"})
			return
		}
		if !*request.Enabled && r.TLS == nil {
			writeJSON(w, 409, map[string]string{"error": "https_required"})
			return
		}
		if err := service.HTTPS.SetHTTP(*request.Enabled); err != nil {
			writeJSON(w, 500, map[string]string{"error": "Couldn't save HTTPS settings."})
			return
		}
		writeJSON(w, 200, service.HTTPS.Status(r.TLS != nil))
	})
	api.HandleFunc("POST /__vim4/api/https/tailscale/retry", func(w http.ResponseWriter, r *http.Request) {
		service.HTTPS.Refresh(context.WithoutCancel(r.Context()), true)
		w.WriteHeader(http.StatusAccepted)
	})
	mux.Handle("/__vim4/api/https", sessions.Require(api))
	mux.Handle("/__vim4/api/https/", sessions.Require(api))
	mux.HandleFunc("GET /__vim4/ca.crt", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-x509-ca-cert")
		w.Header().Set("Content-Disposition", `attachment; filename="vim4-kvm-ca.crt"`)
		_, _ = w.Write(service.HTTPS.CA())
	})
}

// HTTPAccess preserves loopback tools and redirects other cleartext clients.
// The target port comes from the paired listener, including custom CLI ports.
func HTTPAccess(settings *board.HTTPS, next http.Handler, tlsAddress string) http.Handler {
	_, port, _ := net.SplitHostPort(tlsAddress)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS != nil || settings.HTTPEnabled() || auth.Peer(r.RemoteAddr).IsLoopback() {
			next.ServeHTTP(w, r)
			return
		}
		host := r.Host
		if name, _, err := net.SplitHostPort(host); err == nil {
			host = name
		}
		host = strings.Trim(host, "[]")
		if port != "" && port != "443" {
			host = net.JoinHostPort(host, port)
		} else if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
		http.Redirect(w, r, "https://"+host+r.URL.RequestURI(), http.StatusPermanentRedirect)
	})
}

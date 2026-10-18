package web

import (
	"io/fs"
	"net/http"

	"github.com/vim4-kvm/vim4-manager/internal/auth"
	"github.com/vim4-kvm/vim4-manager/internal/board"
)

// AuthenticatedHandler is the production manager entrypoint. Handler remains
// the isolated board API used by unit tests without credentials or hardware.
func AuthenticatedHandler(service *board.Service, assets fs.FS, sessions *auth.Store) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/__vim4/", AuthHandler(assets, sessions))
	mux.Handle("/api/account/", sessions.AccountRoutes())
	boardHandler := Handler(service, assets)
	mux.Handle("/api/", sessions.Require(boardHandler))
	mux.Handle("/", boardHandler)
	return localWrites(requireJSON(mux))
}

// AuthHandler serves the reserved login namespace on any manager listener.
// The caller must apply CheckHost to this handler and all other routes.
func AuthHandler(assets fs.FS, sessions *auth.Store) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/__vim4/api/auth/", sessions.Routes())
	mux.Handle("GET /__vim4/assets/", http.FileServerFS(assets))
	mux.HandleFunc("GET /__vim4/login", func(w http.ResponseWriter, r *http.Request) {
		b, e := fs.ReadFile(assets, "login.html")
		if e != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(b)
	})
	return localWrites(requireJSON(mux))
}

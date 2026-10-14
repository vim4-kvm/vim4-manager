// Package web serves the dashboard API and the embedded frontend.
package web

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/board"
)

// Handler builds the HTTP routes. assets is the built frontend (index.html at its root).
func Handler(service *board.Service, assets fs.FS) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		status, err := service.Status(ctx)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, status)
	})
	mux.HandleFunc("POST /api/select", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			App string `json:"app"`
		}
		if !decode(w, r, &request) {
			return
		}
		respond(w, service.Select(r.Context(), request.App))
	})
	mux.HandleFunc("POST /api/restart", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Unit string `json:"unit"`
		}
		if !decode(w, r, &request) {
			return
		}
		respond(w, service.Restart(r.Context(), request.Unit))
	})
	mux.HandleFunc("POST /api/hdr-curve", func(w http.ResponseWriter, r *http.Request) {
		var curve board.HDRCurve
		if !decode(w, r, &curve) {
			return
		}
		respond(w, service.SetHDRCurve(r.Context(), curve))
	})
	mux.HandleFunc("POST /api/hdr-curve/preview", func(w http.ResponseWriter, r *http.Request) {
		var curve board.HDRCurve
		if !decode(w, r, &curve) {
			return
		}
		respond(w, service.PreviewHDRCurve(r.Context(), curve))
	})
	files := http.FileServerFS(assets)
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			// Vite fingerprints asset names.
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
	return requireJSON(mux)
}

// requireJSON rejects cross-site form posts: the API has no authentication on
// the trusted LAN, and a JSON content type forces a CORS preflight that another
// web page cannot pass.
func requireJSON(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		media, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if r.Method == http.MethodPost && media != "application/json" {
			writeError(w, http.StatusUnsupportedMediaType, errors.New("需要 application/json"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func decode(w http.ResponseWriter, r *http.Request, target any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("请求格式错误"))
		return false
	}
	return true
}

func respond(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, board.ErrBusy):
		writeError(w, http.StatusConflict, err)
	case err != nil:
		writeError(w, http.StatusBadRequest, err)
	default:
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

func writeError(w http.ResponseWriter, code int, err error) {
	slog.Warn("request failed", "status", code, "error", err)
	writeJSON(w, code, map[string]string{"error": err.Error()})
}

func writeJSON(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}

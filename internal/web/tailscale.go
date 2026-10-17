package web

import (
	"context"
	"net/http"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/board"
)

func tailscaleRoutes(mux *http.ServeMux, service *board.Service) {
	mux.HandleFunc("POST /api/tailscale/ping", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			IP string `json:"ip"`
		}
		if !decode(w, r, &request) {
			return
		}
		result, err := service.TailscalePing(r.Context(), request.IP)
		if err != nil {
			respond(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	})
	mux.HandleFunc("GET /api/tailscale", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		state, err := service.Tailscale(ctx)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, state)
	})
	mux.HandleFunc("POST /api/tailscale", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Action     string `json:"action"`
			ControlURL string `json:"controlURL"`
		}
		if !decode(w, r, &request) {
			return
		}
		authURL, err := service.TailscaleAction(r.Context(), request.Action, request.ControlURL)
		if err == nil && request.Action == "login" {
			writeJSON(w, http.StatusOK, map[string]string{"authURL": authURL})
			return
		}
		respond(w, err)
	})
}

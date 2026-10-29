package web

import (
	"context"
	"github.com/vim4-kvm/vim4-manager/internal/i18n"
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
			respond(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	})
	mux.HandleFunc("GET /api/tailscale", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		state, err := service.Tailscale(ctx)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, err)
			return
		}
		state.Writable = true
		if state.Job != nil {
			board.LocalizeTailscaleJob(state.Job, i18n.RequestLocale(r))
		}
		writeJSON(w, http.StatusOK, state)
	})
	mux.HandleFunc("POST /api/tailscale", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Action             string `json:"action"`
			ControlURL         string `json:"controlURL"`
			PreviousControlURL string `json:"previousControlURL"`
			Confirmed          bool   `json:"confirmed"`
		}
		if !decode(w, r, &request) {
			return
		}
		if (request.Action == "down" || request.Action == "logout" || request.Action == "uninstall") && !request.Confirmed {
			writeError(w, r, http.StatusBadRequest, i18n.New("tailscale.confirmDisconnect", nil))
			return
		}
		if request.PreviousControlURL != "" && (!request.Confirmed || request.Action != "login") {
			writeError(w, r, http.StatusBadRequest, i18n.New("tailscale.confirmServer", nil))
			return
		}
		authURL, err := service.TailscaleAction(r.Context(), request.Action, request.ControlURL, request.PreviousControlURL)
		if err == nil && request.Action == "login" {
			writeJSON(w, http.StatusOK, map[string]string{"authURL": authURL})
			return
		}
		respond(w, r, err)
	})
}

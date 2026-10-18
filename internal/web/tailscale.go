package web

import (
	"context"
	"errors"
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
		state.Writable = true
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
			writeError(w, http.StatusBadRequest, errors.New("请确认此操作会断开 Tailscale 远程连接"))
			return
		}
		if request.PreviousControlURL != "" && (!request.Confirmed || request.Action != "login") {
			writeError(w, http.StatusBadRequest, errors.New("请确认切换控制服务器"))
			return
		}
		authURL, err := service.TailscaleAction(r.Context(), request.Action, request.ControlURL, request.PreviousControlURL)
		if err == nil && request.Action == "login" {
			writeJSON(w, http.StatusOK, map[string]string{"authURL": authURL})
			return
		}
		respond(w, err)
	})
}

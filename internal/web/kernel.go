package web

import (
	"context"
	"github.com/vim4-kvm/vim4-manager/internal/board"
	"net/http"
	"time"
)

func kernelRoutes(mux *http.ServeMux, service *board.Service) {
	mux.HandleFunc("GET /api/kernel", func(w http.ResponseWriter, r *http.Request) {
		state, err := service.Kernels(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, state)
	})
	mux.HandleFunc("POST /api/kernel", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     string `json:"id"`
			Reboot bool   `json:"reboot"`
		}
		if !decode(w, r, &request) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
		defer cancel()
		respond(w, service.SelectKernel(ctx, request.ID, request.Reboot))
	})
}

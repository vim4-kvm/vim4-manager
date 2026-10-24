package web

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/board"
)

func passthroughRoutes(mux *http.ServeMux, service *board.Service) {
	mux.HandleFunc("GET /api/passthrough", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		state, err := service.PassthroughStatus(ctx)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, state)
	})
	mux.HandleFunc("POST /api/passthrough", func(w http.ResponseWriter, r *http.Request) {
		var change board.PassthroughChange
		if !decode(w, r, &change) {
			return
		}
		if change.Enabled == nil && change.Audio == nil {
			writeError(w, http.StatusBadRequest, errors.New("需要 enabled 或 audio 布尔值"))
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		state, err := service.SetPassthrough(ctx, change)
		if err != nil {
			code := http.StatusInternalServerError
			if errors.Is(err, board.ErrPassthroughUnsupported) || errors.Is(err, board.ErrBusy) {
				code = http.StatusConflict
			}
			writeError(w, code, err)
			return
		}
		writeJSON(w, http.StatusOK, state)
	})
}

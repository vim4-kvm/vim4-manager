package web

import (
	"github.com/vim4-kvm/vim4-manager/internal/board"
	"net/http"
)

func nasdiskRoutes(mux *http.ServeMux, service *board.Service) {
	mux.HandleFunc("GET /api/nasdisk", func(w http.ResponseWriter, r *http.Request) {
		result, err := service.NASDiskCommand(r.Context(), "status", nil)
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"known": false, "session": nil, "last": nil, "pending": []any{}})
			return
		}
		writeJSON(w, http.StatusOK, result)
	})
	for _, action := range []string{"start", "cancel", "commit", "reattach", "discard", "trash-empty"} {
		mux.HandleFunc("POST /api/nasdisk/"+action, func(w http.ResponseWriter, r *http.Request) {
			var request board.NASDiskRequest
			if !decode(w, r, &request) {
				return
			}
			result, err := service.NASDiskCommand(r.Context(), action, &request)
			if err != nil {
				respond(w, err)
				return
			}
			writeJSON(w, http.StatusOK, result)
		})
	}
}

package web

import (
	"net/http"

	"github.com/vim4-kvm/vim4-manager/internal/board"
)

func storageRoutes(mux *http.ServeMux, service *board.Service) {
	mux.HandleFunc("GET /api/storage", func(w http.ResponseWriter, r *http.Request) {
		result, err := service.StorageCommand(r.Context(), "storage-list", nil)
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"known": false, "tools": map[string]bool{"smb": false, "nfs": false}, "storages": []any{}})
			return
		}
		writeJSON(w, http.StatusOK, result)
	})
	mux.HandleFunc("GET /api/storage/dirs", func(w http.ResponseWriter, r *http.Request) {
		result, err := service.StorageCommand(r.Context(), "storage-dirs", nil, r.URL.Query().Get("id"), r.URL.Query().Get("path"))
		if err != nil {
			respond(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	})
	for _, action := range []string{"save", "test", "mount", "unmount", "delete"} {
		endpoint := "/api/storage/" + action
		if action == "save" {
			endpoint = "/api/storage"
		}
		mux.HandleFunc("POST "+endpoint, func(w http.ResponseWriter, r *http.Request) {
			var request board.StorageRequest
			if !decode(w, r, &request) {
				return
			}
			var args []string
			if action == "mount" || action == "unmount" || action == "delete" {
				args = []string{request.ID}
			}
			result, err := service.StorageCommand(r.Context(), "storage-"+action, &request, args...)
			if err != nil {
				respond(w, err)
				return
			}
			writeJSON(w, http.StatusOK, result)
		})
	}
}

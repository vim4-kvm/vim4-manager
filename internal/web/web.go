// Package web serves the dashboard API and the embedded frontend.
package web

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/board"
)

// Handler builds the HTTP routes. assets is the built frontend (index.html at its root).
func Handler(service *board.Service, assets fs.FS) http.Handler {
	mux := http.NewServeMux()
	diskRoutes(mux, service)
	storageRoutes(mux, service)
	nasdiskRoutes(mux, service)
	tailscaleRoutes(mux, service)
	mux.HandleFunc("GET /api/media", func(w http.ResponseWriter, r *http.Request) {
		images, err := service.MediaImages(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, images)
	})
	mux.HandleFunc("POST /api/media/mount", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			App      string `json:"app"`
			Image    string `json:"image"`
			CDROM    *bool  `json:"cdrom"`
			ReadOnly *bool  `json:"readOnly"`
		}
		if !decode(w, r, &request) {
			return
		}
		if request.CDROM == nil || request.ReadOnly == nil {
			writeError(w, http.StatusBadRequest, errors.New("需要 cdrom 和 readOnly 布尔值"))
			return
		}
		respond(w, service.MountMedia(r.Context(), request.App, request.Image, *request.CDROM, *request.ReadOnly))
	})
	mux.HandleFunc("POST /api/media/eject", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Token     string `json:"token"`
			Confirmed bool   `json:"confirmed"`
		}
		if !decode(w, r, &request) {
			return
		}
		if !request.Confirmed {
			writeError(w, http.StatusBadRequest, errors.New("请确认被控电脑已停止使用磁盘并安全卸载"))
			return
		}
		respond(w, service.EjectMedia(r.Context(), request.Token))
	})
	mux.HandleFunc("GET /api/edid", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		state, err := service.EDID(ctx)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, state)
	})
	mux.HandleFunc("POST /api/edid", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID string `json:"id"`
		}
		if !decode(w, r, &request) {
			return
		}
		respond(w, service.SetEDID(r.Context(), request.ID))
	})
	mux.HandleFunc("GET /api/wifi", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		state, err := service.Wifi(ctx)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		if local, ok := r.Context().Value(http.LocalAddrContextKey).(net.Addr); ok {
			if host, _, err := net.SplitHostPort(local.String()); err == nil {
				state.ViaWifi = service.WifiUsesAddress(ctx, state.Device, host)
			}
		}
		writeJSON(w, http.StatusOK, state)
	})
	mux.HandleFunc("POST /api/wifi", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Enabled *bool `json:"enabled"`
		}
		if !decode(w, r, &request) {
			return
		}
		if request.Enabled == nil {
			writeError(w, http.StatusBadRequest, errors.New("需要 enabled 布尔值"))
			return
		}
		respond(w, service.SetWifi(r.Context(), *request.Enabled))
	})
	wifiRoutes(mux, service)
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
	mux.HandleFunc("POST /api/fan-curve", func(w http.ResponseWriter, r *http.Request) {
		var triggers board.FanTriggers
		if !decode(w, r, &triggers) {
			return
		}
		respond(w, service.SetFanCurve(r.Context(), triggers))
	})
	mux.HandleFunc("GET /api/updates", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		writeJSON(w, http.StatusOK, service.Updates(ctx))
	})
	mux.HandleFunc("POST /api/updates", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Package string `json:"package"`
		}
		if !decode(w, r, &request) {
			return
		}
		respond(w, service.Update(r.Context(), request.Package))
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
	return localWrites(requireJSON(mux))
}

func wifiRoutes(mux *http.ServeMux, service *board.Service) {
	mux.HandleFunc("GET /api/wifi/networks", func(w http.ResponseWriter, r *http.Request) {
		networks, err := service.WifiNetworks(r.Context(), r.URL.Query().Get("rescan") == "1")
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"networks": networks})
	})
	mux.HandleFunc("POST /api/wifi/connect", func(w http.ResponseWriter, r *http.Request) {
		var request board.WifiConnectRequest
		if !decode(w, r, &request) {
			return
		}
		respond(w, service.ConnectWifi(r.Context(), request))
	})
	mux.HandleFunc("POST /api/wifi/activate", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID string `json:"id"`
		}
		if !decode(w, r, &request) {
			return
		}
		respond(w, service.ActivateWifi(r.Context(), request.ID))
	})
	mux.HandleFunc("POST /api/wifi/disconnect", func(w http.ResponseWriter, r *http.Request) {
		var request struct{}
		if !decode(w, r, &request) {
			return
		}
		respond(w, service.DisconnectWifi(r.Context()))
	})
	mux.HandleFunc("POST /api/wifi/forget", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID string `json:"id"`
		}
		if !decode(w, r, &request) {
			return
		}
		respond(w, service.ForgetWifi(r.Context(), request.ID))
	})
	mux.HandleFunc("POST /api/wifi/autoconnect", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID      string `json:"id"`
			Enabled *bool  `json:"enabled"`
		}
		if !decode(w, r, &request) {
			return
		}
		if request.Enabled == nil {
			writeError(w, http.StatusBadRequest, errors.New("需要 enabled 布尔值"))
			return
		}
		respond(w, service.SetWifiAutoconnect(r.Context(), request.ID, *request.Enabled))
	})
	mux.HandleFunc("POST /api/wifi/hotspot", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			SSID      string `json:"ssid"`
			Password  string `json:"password"`
			Channel   *int   `json:"channel"`
			Autostart *bool  `json:"autostart"`
		}
		if !decode(w, r, &request) {
			return
		}
		if request.Channel == nil || request.Autostart == nil {
			writeError(w, http.StatusBadRequest, errors.New("需要 channel 整数和 autostart 布尔值"))
			return
		}
		respond(w, service.SetWifiHotspot(r.Context(), board.WifiHotspotRequest{
			SSID: request.SSID, Password: request.Password, Channel: *request.Channel, Autostart: *request.Autostart,
		}))
	})
	mux.HandleFunc("POST /api/wifi/mode", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Mode  string `json:"mode"`
			Force bool   `json:"force"`
		}
		if !decode(w, r, &request) {
			return
		}
		respond(w, service.SetWifiMode(r.Context(), request.Mode, request.Force))
	})
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

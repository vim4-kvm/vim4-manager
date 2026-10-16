package web

import (
	"errors"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"

	"github.com/vim4-kvm/vim4-manager/internal/board"
)

type diskRequest struct {
	Name          string `json:"name"`
	Disk          string `json:"disk"`
	SizeMiB       int64  `json:"sizeMiB"`
	Label         string `json:"label"`
	Confirm       string `json:"confirm"`
	KeepSnapshots bool   `json:"keepSnapshots"`
	Snapshot      bool   `json:"snapshot"`
	Path          string `json:"path"`
	From          string `json:"from"`
	To            string `json:"to"`
	ID            string `json:"id"`
}

func diskRoutes(mux *http.ServeMux, service *board.Service) {
	query := func(w http.ResponseWriter, r *http.Request, command string, args ...string) {
		result, err := service.DiskCommand(r.Context(), command, args...)
		if err != nil {
			respond(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	}
	mux.HandleFunc("GET /api/disks", func(w http.ResponseWriter, r *http.Request) {
		query(w, r, "disk-list")
	})
	mux.HandleFunc("GET /api/disks/files", func(w http.ResponseWriter, r *http.Request) {
		query(w, r, "disk-ls", r.URL.Query().Get("disk"), r.URL.Query().Get("path"))
	})
	for _, endpoint := range []string{"", "/delete", "/format", "/resize", "/label", "/check", "/mkdir", "/rm", "/mv", "/snapshot", "/restore", "/snapshot/delete"} {
		mux.HandleFunc("POST /api/disks"+endpoint, func(w http.ResponseWriter, r *http.Request) {
			var request diskRequest
			if !decode(w, r, &request) {
				return
			}
			name := request.Name
			if endpoint == "/restore" {
				name = request.Disk
			}
			if (endpoint == "/delete" || endpoint == "/format" || endpoint == "/restore" || endpoint == "/resize") && (name == "" || request.Confirm != name) {
				respond(w, errors.New("请确认完整的数据盘名称"))
				return
			}
			var command string
			var args []string
			switch endpoint {
			case "/resize":
				command, args = "disk-resize", []string{name, strconv.FormatInt(request.SizeMiB, 10)}
			case "":
				command, args = "disk-create", []string{name, strconv.FormatInt(request.SizeMiB, 10), request.Label}
			case "/delete":
				keep := "0"
				if request.KeepSnapshots {
					keep = "1"
				}
				command, args = "disk-delete", []string{name, keep}
			case "/format":
				command, args = "disk-format", []string{name, request.Label}
				if request.Snapshot {
					args = append(args, "1")
				}
			case "/label":
				command, args = "disk-label", []string{name, request.Label}
			case "/check":
				command, args = "disk-check", []string{name}
			case "/mkdir", "/rm":
				command, args = "disk-"+endpoint[1:], []string{request.Disk, request.Path}
			case "/mv":
				command, args = "disk-mv", []string{request.Disk, request.From, request.To}
			case "/snapshot":
				command, args = "disk-snapshot", []string{request.Disk}
			case "/restore":
				command, args = "disk-restore", []string{request.Disk, request.ID}
			case "/snapshot/delete":
				command, args = "disk-snapshot-delete", []string{request.Disk, request.ID}
			}
			query(w, r, command, args...)
		})
	}
	mux.HandleFunc("PUT /api/disks/file", func(w http.ResponseWriter, r *http.Request) {
		contentType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if contentType != "application/octet-stream" || r.Header.Get("X-Vim4-Upload") != "1" {
			writeError(w, http.StatusUnsupportedMediaType, errors.New("需要 application/octet-stream 和 X-Vim4-Upload: 1"))
			return
		}
		if r.ContentLength < 0 || (r.ContentLength == 0 && r.Header.Get("Content-Length") == "") {
			writeError(w, http.StatusLengthRequired, errors.New("需要 Content-Length"))
			return
		}
		mode := r.URL.Query().Get("overwrite")
		if mode != "0" && mode != "1" {
			respond(w, errors.New("overwrite 需为 0 或 1"))
			return
		}
		respond(w, service.UploadDiskFile(r.Context(), r.URL.Query().Get("disk"), r.URL.Query().Get("path"), r.ContentLength, mode == "1", r.Body))
	})
	for _, endpoint := range []string{"file", "image"} {
		mux.HandleFunc("GET /api/disks/"+endpoint, func(w http.ResponseWriter, r *http.Request) {
			disk, file := r.URL.Query().Get("disk"), r.URL.Query().Get("path")
			filename := path.Base(file)
			if endpoint == "image" {
				filename = disk
			}
			out := &diskDownload{ResponseWriter: w, filename: filename}
			if err := service.DownloadDisk(r.Context(), disk, file, endpoint == "image", out); err != nil {
				if out.started {
					// Once bytes are sent, abort rather than append JSON to a corrupt download.
					panic(http.ErrAbortHandler)
				}
				respond(w, err)
				return
			}
			out.start()
		})
	}
}

type diskDownload struct {
	http.ResponseWriter
	filename string
	started  bool
}

func (w *diskDownload) start() {
	if !w.started {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+strings.ReplaceAll(url.QueryEscape(w.filename), "+", "%20"))
		w.WriteHeader(http.StatusOK)
		w.started = true
	}
}

func (w *diskDownload) Write(data []byte) (int, error) {
	w.start()
	return w.ResponseWriter.Write(data)
}

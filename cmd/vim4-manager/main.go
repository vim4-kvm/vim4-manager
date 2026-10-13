// Command vim4-manager serves the VIM4 KVM management dashboard.
package main

import (
	"context"
	"errors"
	"flag"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	vim4manager "github.com/vim4-kvm/vim4-manager"
	"github.com/vim4-kvm/vim4-manager/internal/board"
	"github.com/vim4-kvm/vim4-manager/internal/web"
)

func main() {
	listen := flag.String("listen", ":80", "HTTP listen address")
	flag.Parse()
	assets, err := fs.Sub(vim4manager.Assets, "web/dist")
	if err != nil {
		slog.Error("frontend", "error", err)
		os.Exit(1)
	}
	service := &board.Service{Run: board.Exec, Root: "/"}
	server := &http.Server{Addr: *listen, Handler: web.Handler(service, assets), ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	slog.Info("listening", "address", *listen)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server", "error", err)
		os.Exit(1)
	}
}

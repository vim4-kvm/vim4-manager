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
	"strings"
	"syscall"
	"time"

	vim4manager "github.com/vim4-kvm/vim4-manager"
	"github.com/vim4-kvm/vim4-manager/internal/auth"
	"github.com/vim4-kvm/vim4-manager/internal/board"
	"github.com/vim4-kvm/vim4-manager/internal/web"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "gpu-snapshot" {
		if err := board.WriteGPUSnapshot(os.Stdout); err != nil {
			slog.Error("GPU snapshot", "error", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "set-password" {
		if err := auth.PasswordCommand(os.Args[2:], os.Stdin, os.Stderr); err != nil {
			slog.Error("set password", "error", err)
			os.Exit(1)
		}
		return
	}
	listen := flag.String("listen", ":80", "HTTP listen address")
	kvmListen := flag.String("kvm-listen", ":8080", "KVM gateway listen address")
	kvmBackend := flag.String("kvm-backend", "127.0.0.1:8081", "KVM backend address")
	stateDir := flag.String("state-dir", auth.DefaultDirectory, "Authentication state directory")
	allowedHosts := flag.String("allowed-hosts", "", "Additional trusted HTTP hostnames, comma-separated")
	flag.Parse()
	assets, err := fs.Sub(vim4manager.Assets, "web/dist")
	if err != nil {
		slog.Error("frontend", "error", err)
		os.Exit(1)
	}
	// 180 samples at 5 s cover the last 15 minutes of the trend charts.
	history := &board.History{Root: "/", Capacity: 180, Execute: board.Exec}
	updater := &board.Updater{Client: &http.Client{}, Dir: board.UpdateDir}
	service := &board.Service{Run: board.Exec, Root: "/", History: history, Events: &board.Events{Capacity: 60}, Updater: updater}
	sessions, err := auth.Open(*stateDir)
	if err != nil {
		slog.Error("authentication", "error", err)
		os.Exit(1)
	}
	service.Passthrough, err = board.OpenPassthrough(context.Background(), *stateDir, nil, service.Events)
	if err != nil {
		slog.Error("passthrough settings", "error", err)
		os.Exit(1)
	}
	server := &http.Server{Addr: *listen, Handler: web.CheckHost(service, web.AuthenticatedHandler(service, assets, sessions), strings.Split(*allowedHosts, ",")), ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	kvmDone := make(chan struct{})
	go func() {
		defer close(kvmDone)
		handler := web.KVMHandler(service, assets, sessions, *kvmBackend, strings.Split(*allowedHosts, ","))
		if err := web.ServeKVM(ctx, *kvmListen, handler, service.Events); err != nil {
			slog.Error("KVM gateway", "error", err)
		}
	}()
	defer func() { stop(); <-kvmDone }()
	authDone := make(chan struct{})
	go func() { sessions.Run(ctx); close(authDone) }()
	defer func() { stop(); <-authDone }()
	go history.Run(ctx, 5*time.Second)
	go service.Watch(ctx, 5*time.Second)
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

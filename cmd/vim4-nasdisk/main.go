package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/vim4-kvm/vim4-manager/internal/nasdisk"
)

func main() {
	if len(os.Args) != 2 || os.Args[1] != "run" {
		fmt.Fprintln(os.Stderr, "usage: vim4-nasdisk run")
		os.Exit(2)
	}
	b, err := os.ReadFile(nasdisk.Runtime + "/session.json")
	var config nasdisk.Config
	if err == nil {
		err = json.Unmarshal(b, &config)
	}
	if err == nil {
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
		defer cancel()
		err = nasdisk.Run(ctx, config)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

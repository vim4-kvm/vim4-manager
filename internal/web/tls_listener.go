package web

import (
	"context"
	"crypto/tls"
	"net/http"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/board"
	"github.com/vim4-kvm/vim4-manager/internal/i18n"
)

// ServeTLS uses the gateway's bind retry and shutdown lifecycle. An occupied
// TLS port leaves the manager and the other gateway listeners available.
func ServeTLS(ctx context.Context, address string, handler http.Handler, config *tls.Config, events *board.Events) error {
	server := &http.Server{Addr: address, Handler: handler, ReadHeaderTimeout: 10 * time.Second, TLSConfig: config}
	return serveListener(ctx, server, events,
		i18n.Message{Key: "events.httpsStarted", Args: map[string]any{"address": address}},
		i18n.Message{Key: "events.httpsWaiting", Args: map[string]any{"address": address}})
}

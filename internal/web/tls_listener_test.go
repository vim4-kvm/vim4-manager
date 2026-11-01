package web

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/board"
)

func TestTLSBindRetryKeepsOtherListenersAvailable(t *testing.T) {
	settings, err := board.OpenHTTPS(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	config := &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: settings.GetCertificate}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(settings.CA())
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}}, Timeout: 200 * time.Millisecond}
	defer client.CloseIdleConnections()
	entered, canceled := make(chan struct{}), make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/wait" {
			connection, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			defer connection.Close()
			close(entered)
			<-r.Context().Done()
			close(canceled)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	httpServer := httptest.NewServer(handler)
	defer httpServer.Close()
	addresses := make([]string, 2)
	occupied := make([]net.Listener, 2)
	results := make([]chan error, 2)
	events := &board.Events{Capacity: 10}
	for i := range occupied {
		occupied[i], err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer occupied[i].Close()
		addresses[i] = occupied[i].Addr().String()
		results[i] = make(chan error, 1)
		go func(i int) { results[i] <- ServeTLS(ctx, addresses[i], handler, config, events) }(i)
	}
	waitFor := func(check func() bool) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for !check() {
			if time.Now().After(deadline) {
				t.Fatal("listener did not reach expected state")
			}
			time.Sleep(time.Millisecond)
		}
	}
	waitFor(func() bool { return len(events.List()) == 2 })
	for _, address := range addresses {
		found := false
		for _, event := range events.List() {
			if event.Tone == "warning" && strings.Contains(event.Text, address) {
				found = true
			}
		}
		if !found {
			t.Fatal("missing unavailable-listener event", address, events.List())
		}
	}
	res, err := http.Get(httpServer.URL)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatal(res.StatusCode)
	}
	// Releasing either port recovers that listener without waiting for its peer.
	for i := range occupied {
		occupied[i].Close()
		waitFor(func() bool {
			res, err := client.Get("https://" + addresses[i])
			if err != nil {
				return false
			}
			defer res.Body.Close()
			return res.StatusCode == http.StatusNoContent
		})
	}
	// BaseContext must cancel in-flight TLS requests during shutdown, including
	// proxy streams whose lifetime is independent of the HTTP connection.
	requestDone := make(chan struct{})
	go func() {
		defer close(requestDone)
		res, err := client.Get("https://" + addresses[1] + "/wait")
		if err == nil {
			_, _ = io.Copy(io.Discard, res.Body)
			res.Body.Close()
		}
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("request did not start")
	}
	cancel()
	select {
	case <-canceled:
	case <-time.After(5 * time.Second):
		t.Fatal("TLS request context not canceled")
	}
	<-requestDone
	for _, result := range results {
		select {
		case err := <-result:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("TLS server did not stop")
		}
	}
}

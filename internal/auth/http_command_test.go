package auth

import (
	"io"
	"testing"

	"github.com/vim4-kvm/vim4-manager/internal/board"
)

func TestHTTPRecoveryCommand(t *testing.T) {
	dir := t.TempDir()
	for _, mode := range []string{"off", "on"} {
		if err := HTTPCommand([]string{"-state-dir", dir, mode}, io.Discard); err != nil {
			t.Fatal(err)
		}
		h, err := board.OpenHTTPS(dir, ":443", ":8443", nil)
		if err != nil {
			t.Fatal(err)
		}
		if h.HTTPEnabled() != (mode == "on") {
			t.Fatal(mode)
		}
	}
	for _, args := range [][]string{nil, {"invalid"}, {"on", "off"}} {
		if HTTPCommand(args, io.Discard) == nil {
			t.Fatal(args)
		}
	}
}

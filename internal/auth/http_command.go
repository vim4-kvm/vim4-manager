package auth

import (
	"errors"
	"flag"
	"io"
	"os"
	"path/filepath"
	"syscall"

	"github.com/vim4-kvm/vim4-manager/internal/board"
)

// HTTPCommand changes the saved preference; the service reads it on restart.
func HTTPCommand(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("set-http", flag.ContinueOnError)
	flags.SetOutput(output)
	dir := flags.String("state-dir", DefaultDirectory, "Manager state directory")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 || (flags.Arg(0) != "on" && flags.Arg(0) != "off") {
		return errors.New("usage: set-http [-state-dir DIR] on|off")
	}
	if err := board.WriteHTTPSetting(*dir, flags.Arg(0) == "on"); err != nil {
		return err
	}
	// sudo recovery must leave the replacement file writable by the service.
	info, err := os.Stat(*dir)
	if err != nil {
		return err
	}
	if os.Geteuid() == 0 {
		if owner, ok := info.Sys().(*syscall.Stat_t); ok {
			return os.Chown(filepath.Join(*dir, "https.json"), int(owner.Uid), int(owner.Gid))
		}
	}
	return nil
}

package auth

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"strconv"

	"golang.org/x/term"
)

// PasswordCommand accepts an injectable input/output for offline command tests.
func PasswordCommand(args []string, input *os.File, output io.Writer) error {
	flags := flag.NewFlagSet("set-password", flag.ContinueOnError)
	flags.SetOutput(output)
	username := flags.String("username", "", "Administrator username (defaults to current username or admin)")
	dir := flags.String("state-dir", DefaultDirectory, "Authentication state directory")
	if e := flags.Parse(args); e != nil {
		return e
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected arguments")
	}
	var password string
	if term.IsTerminal(int(input.Fd())) {
		fmt.Fprint(output, "Password: ")
		first, e := term.ReadPassword(int(input.Fd()))
		fmt.Fprintln(output)
		if e != nil {
			return e
		}
		fmt.Fprint(output, "Confirm password: ")
		second, e := term.ReadPassword(int(input.Fd()))
		fmt.Fprintln(output)
		if e != nil {
			return e
		}
		if string(first) != string(second) {
			return errors.New("passwords don't match")
		}
		password = string(first)
	} else {
		scanner := bufio.NewScanner(input)
		if !scanner.Scan() {
			return errors.New("couldn't read password")
		}
		password = scanner.Text()
	}
	s, e := Open(*dir)
	if e != nil {
		return e
	}
	if e = s.SetPassword(context.Background(), *username, password); e != nil {
		return e
	}
	if os.Geteuid() == 0 {
		account, e := user.Lookup("khadas")
		if e != nil {
			return fmt.Errorf("resolve khadas ownership: %w", e)
		}
		uid, e := strconv.Atoi(account.Uid)
		if e != nil {
			return e
		}
		gid, e := strconv.Atoi(account.Gid)
		if e != nil {
			return e
		}
		for _, path := range []string{*dir, filepath.Join(*dir, "auth.json"), filepath.Join(*dir, "sessions.json")} {
			if e = os.Chown(path, uid, gid); e != nil {
				return e
			}
		}
	}
	fmt.Fprintln(output, "Password updated. All devices have been signed out.")
	return nil
}

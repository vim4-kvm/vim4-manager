package board

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestStorageCredentialsOnlyOnStdin(t *testing.T) {
	password := "private-password"
	for _, action := range []string{"storage-save", "storage-test"} {
		s := &Service{Stream: func(_ context.Context, in io.Reader, out io.Writer, name string, args ...string) error {
			if name != "sudo" || strings.Join(args, " ") != "-n "+Helper+" "+action {
				t.Fatalf("unexpected command %s %v", name, args)
			}
			var request StorageRequest
			if err := json.NewDecoder(in).Decode(&request); err != nil || request.Password == nil || *request.Password != password || request.Server != "nas.local" {
				t.Fatal("request not forwarded on stdin")
			}
			_, err := io.WriteString(out, `{"ok":true}`)
			return err
		}}
		if _, err := s.StorageCommand(context.Background(), action, &StorageRequest{Password: &password, Server: "nas.local"}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestStorageErrorsAndAbsentPassword(t *testing.T) {
	var failure error
	s := &Service{Stream: func(_ context.Context, in io.Reader, out io.Writer, _ string, _ ...string) error {
		data, _ := io.ReadAll(in)
		if strings.Contains(string(data), "password") {
			t.Fatal("omitted password became an empty password")
		}
		_, _ = io.WriteString(out, "invalid json")
		return failure
	}}
	if _, err := s.StorageCommand(context.Background(), "storage-save", &StorageRequest{}); err == nil {
		t.Fatal("invalid helper response accepted")
	}
	failure = ErrBusy
	if _, err := s.StorageCommand(context.Background(), "storage-mount", nil, "nas"); !errors.Is(err, ErrBusy) {
		t.Fatal("busy error lost")
	}
	password := "secret"
	s.Stream = func(context.Context, io.Reader, io.Writer, string, ...string) error {
		return errors.New("unexpected secret output")
	}
	_, err := s.StorageCommand(context.Background(), "storage-test", &StorageRequest{Password: &password})
	if err == nil || strings.Contains(err.Error(), password) {
		t.Fatal("password leaked in error")
	}
}

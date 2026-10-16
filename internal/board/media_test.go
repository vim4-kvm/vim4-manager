package board

import (
	"context"
	"errors"
	"testing"
)

func TestMediaReadFailureIsNotAnEjectedDrive(t *testing.T) {
	for _, input := range []struct {
		data string
		err  error
	}{
		{"", errors.New("helper busy")}, {"invalid json", nil}, {"{}", nil},
	} {
		s := &Service{Run: func(context.Context, string, ...string) (string, error) { return input.data, input.err }}
		if s.media(context.Background()).Known {
			t.Fatal("failed read marked known")
		}
	}
	s := &Service{Run: func(context.Context, string, ...string) (string, error) {
		return `{"known":true,"inserted":false}`, nil
	}}
	if !s.media(context.Background()).Known {
		t.Fatal("successful empty LUN lost")
	}
}

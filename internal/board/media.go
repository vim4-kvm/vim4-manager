package board

import (
	"context"
	"encoding/json"
	"time"
)

// Media describes the shared USB LUN, independent of the selected application.
type Media struct {
	Known     bool   `json:"known"`
	Inserted  bool   `json:"inserted"`
	Name      string `json:"name"`
	ReadOnly  bool   `json:"readOnly"`
	CDROM     bool   `json:"cdrom"`
	Connected bool   `json:"connected"`
	PiKVM     bool   `json:"pikvm"`
}

func (s *Service) media(ctx context.Context) Media {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	data, err := s.Run(ctx, "sudo", "-n", Helper, "media-status")
	var media Media
	if err != nil || json.Unmarshal([]byte(data), &media) != nil {
		// Unknown is not an empty drive: the UI must never auto-switch on failure.
		return Media{}
	}
	return media
}

package board

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"
)

// Media describes the shared USB LUN, independent of the selected application.
type Media struct {
	Known     bool          `json:"known"`
	Inserted  bool          `json:"inserted"`
	Name      string        `json:"name"`
	Token     string        `json:"token"`
	ReadOnly  bool          `json:"readOnly"`
	CDROM     bool          `json:"cdrom"`
	Connected bool          `json:"connected"`
	PiKVM     bool          `json:"pikvm"`
	NASDisk   *NASDiskMedia `json:"nasdisk,omitempty"`
}

type NASDiskMedia struct {
	Storage     string `json:"storage"`
	StorageName string `json:"storageName"`
	Path        string `json:"path"`
	Mode        string `json:"mode"`
}

type MediaImage struct {
	Disk   bool   `json:"disk,omitempty"`
	ID     string `json:"id"`
	Name   string `json:"name"`
	Source string `json:"source"`
	Size   int64  `json:"size"`
	CDROM  bool   `json:"cdrom"`
}

func (s *Service) MediaImages(ctx context.Context) ([]MediaImage, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	data, err := s.Run(ctx, "sudo", "-n", Helper, "media-list")
	if err != nil {
		return nil, fmt.Errorf("读取镜像列表失败：%w", err)
	}
	images := []MediaImage{}
	if err := json.Unmarshal([]byte(data), &images); err != nil {
		return nil, fmt.Errorf("镜像列表无效：%w", err)
	}
	return images, nil
}

func (s *Service) MountMedia(ctx context.Context, app, image string, cdrom, readonly bool) error {
	return s.helper(ctx, "media-mount", app, image, strconv.FormatBool(cdrom), strconv.FormatBool(readonly))
}

func (s *Service) EjectMedia(ctx context.Context, token string) error {
	return s.helper(ctx, "media-eject", token)
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

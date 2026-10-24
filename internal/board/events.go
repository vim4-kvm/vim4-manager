package board

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// Event is one line of the overview's recent-events list.
type Event struct {
	UnixMs int64  `json:"t"`
	Tone   string `json:"tone"`
	Text   string `json:"text"`
}

// Events keeps recent events in memory; they restart empty with the service.
type Events struct {
	Capacity int

	mu     sync.Mutex
	events []Event
	now    func() time.Time
}

func (e *Events) Add(tone, format string, args ...any) {
	if e == nil {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	clock := time.Now
	if e.now != nil {
		clock = e.now
	}
	e.events = append(e.events, Event{clock().UnixMilli(), tone, fmt.Sprintf(format, args...)})
	if over := len(e.events) - e.Capacity; over > 0 {
		e.events = append(e.events[:0], e.events[over:]...)
	}
}

// List returns a copy, newest first.
func (e *Events) List() []Event {
	if e == nil {
		return []Event{}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	list := make([]Event, len(e.events))
	for i, event := range e.events {
		list[len(e.events)-1-i] = event
	}
	return list
}

// snapshot is the state the watcher compares between polls.
type snapshot struct {
	hdmi  HDMI
	usb   string
	tempC float64
	hot   bool
	units map[string]Unit
}

// Watch records state changes nobody asked for: HDMI signal, USB enumeration,
// services stopping or failing, and SoC overheating.
func (s *Service) Watch(ctx context.Context, interval time.Duration) {
	s.Events.Add("idle", "管理服务启动")
	var last *snapshot
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if next, err := s.snapshot(ctx); err == nil {
			if last != nil {
				s.compare(last, next)
			}
			last = next
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Service) snapshot(ctx context.Context) (*snapshot, error) {
	// Observe passthrough changes even when no browser has the output page open.
	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	_, _ = s.PassthroughStatus(probeCtx)
	cancel()
	units, err := QueryUnits(ctx, s.Run, allUnits())
	if err != nil {
		return nil, err
	}
	h := ReadHardware(s.Root)
	return &snapshot{hdmi: h.HDMI, usb: h.USB, tempC: h.TempC, units: units}, nil
}

// Overheat warning with hysteresis so a reading hovering at the limit logs once.
const (
	hotC  = 85
	coolC = 80
)

func (s *Service) compare(old, now *snapshot) {
	switch {
	case old.hdmi.Signal && !now.hdmi.Signal:
		s.Events.Add("warning", "HDMI 信号丢失")
	case !old.hdmi.Signal && now.hdmi.Signal:
		s.Events.Add("good", "HDMI 信号恢复：%s", hdmiMode(now.hdmi))
	case now.hdmi.Signal && hdmiMode(old.hdmi) != hdmiMode(now.hdmi):
		s.Events.Add("idle", "HDMI 输入变为 %s", hdmiMode(now.hdmi))
	}
	if old.usb != now.usb {
		if now.usb == "configured" {
			s.Events.Add("good", "被控机已枚举 USB 键鼠")
		} else if old.usb == "configured" {
			s.Events.Add("warning", "USB 键鼠断开（%s）", orUnknown(now.usb))
		}
	}
	now.hot = old.hot
	if !old.hot && now.tempC >= hotC {
		now.hot = true
		s.Events.Add("critical", "SoC 温度超过 %d °C", hotC)
	} else if old.hot && now.tempC < coolC {
		now.hot = false
		s.Events.Add("good", "SoC 温度回落到 %.0f °C", now.tempC)
	}
	for _, name := range allUnits() {
		before, after := old.units[name], now.units[name]
		if before.Active == after.Active || !after.Loaded {
			continue
		}
		label := unitName(name)
		switch after.Active {
		case "failed":
			s.Events.Add("critical", "%s 失败", label)
		case "active":
			// Oneshot board units finish quickly; only report long-running starts.
			if after.Sub != "exited" {
				s.Events.Add("good", "%s 已启动", label)
			}
		case "inactive":
			s.Events.Add("idle", "%s 已停止", label)
		}
	}
}

func hdmiMode(h HDMI) string {
	mode := fmt.Sprintf("%d×%d@%.0f", h.Width, h.Height, h.RefreshHz)
	if h.HDR != "" && h.HDR != "SDR" {
		mode += " HDR"
	}
	return mode
}

func orUnknown(state string) string {
	if state == "" {
		return "未知"
	}
	return state
}

func unitName(unit string) string {
	for _, app := range Apps {
		if app.Unit == unit {
			return app.Name
		}
	}
	for _, p := range PlatformUnits {
		if p.Unit == unit {
			return p.Name
		}
	}
	return unit
}

// record logs the outcome of a user action.
func (s *Service) record(err error, format string, args ...any) error {
	text := fmt.Sprintf(format, args...)
	switch {
	case err == ErrBusy:
	case err != nil:
		s.Events.Add("critical", "%s失败", text)
	default:
		s.Events.Add("good", "%s", text)
	}
	return err
}

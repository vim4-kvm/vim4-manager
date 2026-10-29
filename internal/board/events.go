package board

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/i18n"
)

// Event is one line of the overview's recent-events list.
type Event struct {
	UnixMs  int64  `json:"t"`
	Tone    string `json:"tone"`
	Text    string `json:"text"`
	message *i18n.Message
}

// Events keeps recent events in memory; they restart empty with the service.
type Events struct {
	Capacity int

	mu     sync.Mutex
	events []Event
	now    func() time.Time
}

func (e *Events) Add(tone, format string, args ...any) {
	e.append(Event{Tone: tone, Text: fmt.Sprintf(format, args...)})
}

// AddMessage retains the template and arguments so each reader gets its locale.
func (e *Events) AddMessage(tone string, message i18n.Message) {
	args := make(map[string]any, len(message.Args))
	for key, value := range message.Args {
		args[key] = value
	}
	message.Args = args
	e.append(Event{Tone: tone, message: &message})
}

func (e *Events) append(event Event) {
	if e == nil {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	clock := time.Now
	if e.now != nil {
		clock = e.now
	}
	event.UnixMs = clock().UnixMilli()
	e.events = append(e.events, event)
	if over := len(e.events) - e.Capacity; over > 0 {
		e.events = append(e.events[:0], e.events[over:]...)
	}
}

// List returns a copy, newest first.
func (e *Events) List(locales ...i18n.Locale) []Event {
	if e == nil {
		return []Event{}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	list := make([]Event, len(e.events))
	locale := i18n.English
	if len(locales) > 0 {
		locale = locales[0]
	}
	for i, event := range e.events {
		if event.message != nil {
			event.Text = event.message.Render(locale)
		}
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
	s.Events.AddMessage("idle", i18n.Message{Key: "events.managerStarted", Args: nil})
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
		s.Events.AddMessage("warning", i18n.Message{Key: "events.hdmiLost", Args: nil})
	case !old.hdmi.Signal && now.hdmi.Signal:
		s.Events.AddMessage("good", i18n.Message{Key: "events.hdmiRestored", Args: map[string]any{"p0": hdmiMode(now.hdmi)}})
	case now.hdmi.Signal && hdmiMode(old.hdmi) != hdmiMode(now.hdmi):
		s.Events.AddMessage("idle", i18n.Message{Key: "events.hdmiChanged", Args: map[string]any{"p0": hdmiMode(now.hdmi)}})
	}
	if old.usb != now.usb {
		if now.usb == "configured" {
			s.Events.AddMessage("good", i18n.Message{Key: "events.usbConnected", Args: nil})
		} else if old.usb == "configured" {
			s.Events.AddMessage("warning", i18n.Message{Key: "events.usbDisconnected", Args: map[string]any{"p0": orUnknown(now.usb)}})
		}
	}
	now.hot = old.hot
	if !old.hot && now.tempC >= hotC {
		now.hot = true
		s.Events.AddMessage("critical", i18n.Message{Key: "events.overheat", Args: map[string]any{"p0": hotC}})
	} else if old.hot && now.tempC < coolC {
		now.hot = false
		s.Events.AddMessage("good", i18n.Message{Key: "events.cooled", Args: map[string]any{"p0": now.tempC}})
	}
	for _, name := range allUnits() {
		before, after := old.units[name], now.units[name]
		if before.Active == after.Active || !after.Loaded {
			continue
		}
		label := unitName(name)
		switch after.Active {
		case "failed":
			s.Events.AddMessage("critical", i18n.Message{Key: "events.serviceFailed", Args: map[string]any{"p0": label}})
		case "active":
			// Oneshot board units finish quickly; only report long-running starts.
			if after.Sub != "exited" {
				s.Events.AddMessage("good", i18n.Message{Key: "events.serviceStarted", Args: map[string]any{"p0": label}})
			}
		case "inactive":
			s.Events.AddMessage("idle", i18n.Message{Key: "events.serviceStopped", Args: map[string]any{"p0": label}})
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

func orUnknown(state string) any {
	if state == "" {
		return i18n.Message{Key: "common.unknown"}
	}
	return state
}

func unitName(unit string) any {
	for name, key := range map[string]string{"vim4-kvm-hdmi.service": "services.hdmi", "vim4-kvm-gadget.service": "services.gadget", "vim4-kvm-pd.service": "services.pd", "vim4-kvm-cpufreq.service": "services.cpufreq"} {
		if unit == name {
			return i18n.Message{Key: key}
		}
	}
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

// recordMessage logs the outcome while retaining its identity for each reader.
func (s *Service) recordMessage(err error, message i18n.Message) error {
	switch {
	case errors.Is(err, ErrBusy):
	case err != nil:
		s.Events.AddMessage("critical", i18n.Message{Key: "events.actionFailed", Args: map[string]any{"action": message}})
	default:
		s.Events.AddMessage("good", message)
	}
	return err
}

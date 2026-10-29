package board

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/i18n"
	"github.com/vim4-kvm/vim4-manager/internal/statefile"
)

var ErrPassthroughUnsupported = i18n.New("output.unsupported", nil)

type PassthroughPreferences struct {
	Enabled bool `json:"enabled"`
	Audio   bool `json:"audio"`
	HDR     bool `json:"hdr"`
}

type PassthroughChange struct {
	Enabled *bool `json:"enabled"`
	Audio   *bool `json:"audio"`
	HDR     *bool `json:"hdr"`
}

type PassthroughInput struct {
	Width       int     `json:"width"`
	Height      int     `json:"height"`
	RefreshHz   float64 `json:"refreshHz"`
	HDR         string  `json:"hdr"`
	ColorFormat string  `json:"colorFormat"`
	Audio       bool    `json:"audio"`
}

type PassthroughMonitor struct {
	Name         string  `json:"name"`
	MaxWidth     int     `json:"maxWidth"`
	MaxHeight    int     `json:"maxHeight"`
	MaxRefreshHz float64 `json:"maxRefreshHz"`
	HDR          bool    `json:"hdr"`
	Audio        bool    `json:"audio"`
}

type PassthroughOutput struct {
	Width       int     `json:"width"`
	Height      int     `json:"height"`
	RefreshHz   float64 `json:"refreshHz"`
	ColorFormat string  `json:"colorFormat"`
	Scaled      bool    `json:"scaled"`
	HDRToSDR    bool    `json:"hdrToSdr"`
}

type PassthroughState struct {
	Supported  bool                `json:"supported"`
	Enabled    bool                `json:"enabled"`
	Audio      bool                `json:"audio"`
	HDR        bool                `json:"hdr"`
	AudioState string              `json:"audioState,omitempty"`
	State      string              `json:"state"`
	Reason     string              `json:"reason,omitempty"`
	Input      *PassthroughInput   `json:"input,omitempty"`
	Monitor    *PassthroughMonitor `json:"monitor,omitempty"`
	Output     *PassthroughOutput  `json:"output,omitempty"`
}

// PassthroughProvider reports actual kernel state. Apply must return actual
// state, including on partial failure; the controller never invents success.
type PassthroughProvider interface {
	Status(context.Context) (PassthroughState, error)
	Apply(context.Context, PassthroughPreferences) (PassthroughState, error)
}

type kernelPassthroughProvider struct {
	run Runner
}

func (p kernelPassthroughProvider) command(ctx context.Context, args ...string) (PassthroughState, error) {
	run := p.run
	if run == nil {
		run = Exec
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	output, err := run(ctx, "sudo", append([]string{"-n", Helper}, args...)...)
	if err != nil {
		log.Printf("passthrough helper %s: %v", args[0], err)
		return PassthroughState{}, i18n.New("output.unresponsive", nil)
	}
	var state PassthroughState
	if err := json.Unmarshal([]byte(output), &state); err != nil || state.State == "" {
		return state, i18n.New("output.invalidState", nil)
	}
	return state, nil
}

func (p kernelPassthroughProvider) Status(ctx context.Context) (PassthroughState, error) {
	return p.command(ctx, "passthrough-status")
}

func (p kernelPassthroughProvider) Apply(ctx context.Context, prefs PassthroughPreferences) (PassthroughState, error) {
	state, err := p.Status(ctx)
	if err != nil {
		return state, err
	}
	if !state.Supported {
		return state, ErrPassthroughUnsupported
	}
	actual, err := p.command(ctx, "passthrough-set", strconv.FormatBool(prefs.Enabled), strconv.FormatBool(prefs.Audio), strconv.FormatBool(prefs.HDR))
	if err != nil {
		if after, readErr := p.Status(ctx); readErr == nil {
			state = after
		}
		return state, err
	}
	return actual, nil
}

// Passthrough owns preferences and serializes kernel operations separately
// from status collection and the manager's privileged helper.
type Passthrough struct {
	mu       sync.Mutex
	changeMu sync.Mutex
	provider PassthroughProvider
	path     string
	events   *Events
	last     *PassthroughState
}

// OpenPassthrough restores saved preferences only when the provider supports
// them. Unsupported kernels preserve the file but report enabled=false.
// A nil provider selects the installed privileged kernel provider.
func OpenPassthrough(ctx context.Context, dir string, provider PassthroughProvider, events *Events) (*Passthrough, error) {
	if provider == nil {
		provider = kernelPassthroughProvider{}
	}
	p := &Passthrough{provider: provider, path: filepath.Join(dir, "passthrough.json"), events: events}
	data, err := os.ReadFile(p.path)
	if err != nil && !os.IsNotExist(err) {
		return nil, i18n.Wrap(err, "output.readFailed", map[string]any{"p0": err})
	}
	if err == nil {
		prefs := PassthroughPreferences{HDR: true}
		if err = json.Unmarshal(data, &prefs); err != nil {
			return nil, i18n.Wrap(err, "output.invalidSettings", map[string]any{"p0": err})
		}
		state, readErr := provider.Status(ctx)
		if readErr != nil {
			return nil, readErr
		}
		if state.Supported {
			p.observe(state)
			state, err = provider.Apply(ctx, prefs)
			if err != nil {
				p.events.AddMessage("critical", i18n.Message{Key: "events.outputFailed", Args: map[string]any{"p0": err}})
				return nil, err
			}
			p.observe(state)
		}
	}
	return p, nil
}

func (p *Passthrough) Status(ctx context.Context) (PassthroughState, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	state, err := p.provider.Status(ctx)
	if err == nil {
		p.observe(state)
	}
	return state, err
}

func (p *Passthrough) Set(ctx context.Context, change PassthroughChange) (PassthroughState, error) {
	if !p.changeMu.TryLock() {
		return PassthroughState{}, ErrBusy
	}
	defer p.changeMu.Unlock()
	p.mu.Lock()
	defer p.mu.Unlock()
	before, err := p.provider.Status(ctx)
	if err != nil {
		return before, p.failure(err)
	}
	p.observe(before)
	if !before.Supported {
		return before, p.failure(ErrPassthroughUnsupported)
	}
	previous := PassthroughPreferences{Enabled: before.Enabled, Audio: before.Audio, HDR: before.HDR}
	next := previous
	if change.Enabled != nil {
		next.Enabled = *change.Enabled
	}
	if change.Audio != nil {
		next.Audio = *change.Audio
	}
	if change.HDR != nil {
		next.HDR = *change.HDR
	}
	state, err := p.provider.Apply(ctx, next)
	if err != nil {
		return state, p.failure(err)
	}
	p.observe(state)
	if err = statefile.WriteJSON(p.path, next); err != nil {
		// Restore the old preference in the kernel when saving fails, so a
		// reported failure does not silently change what survives a restart.
		rollbackCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		actual, rollbackErr := p.provider.Apply(rollbackCtx, previous)
		cancel()
		p.observe(actual)
		err = i18n.Wrap(err, "output.saveFailed", map[string]any{"p0": err})
		if rollbackErr != nil {
			err = i18n.Wrap(err, "output.rollbackFailed", map[string]any{"p0": err, "p1": rollbackErr})
		}
		return actual, p.failure(err)
	}
	return state, nil
}

func (p *Passthrough) failure(err error) error {
	p.events.AddMessage("critical", i18n.Message{Key: "events.outputFailed", Args: map[string]any{"p0": err}})
	return err
}

func passthroughRefresh(hz float64) string {
	return strings.TrimRight(strings.TrimRight(strconv.FormatFloat(hz, 'f', 2, 64), "0"), ".") + "Hz"
}

func (p *Passthrough) observe(state PassthroughState) {
	if p.last != nil && state.Enabled != p.last.Enabled {
		if state.Enabled {
			p.events.AddMessage("good", i18n.Message{Key: "events.outputEnabled", Args: nil})
		} else {
			p.events.AddMessage("idle", i18n.Message{Key: "events.outputDisabled", Args: nil})
		}
	}
	if out := state.Output; state.State == "running" && out != nil && out.Scaled {
		old := p.last
		if old == nil || old.State != "running" || old.Output == nil || !old.Output.Scaled ||
			old.Output.Width != out.Width || old.Output.Height != out.Height || old.Output.RefreshHz != out.RefreshHz {
			p.events.AddMessage("warning", i18n.Message{Key: "events.outputScaled", Args: map[string]any{"p0": out.Width, "p1": out.Height, "p2": passthroughRefresh(out.RefreshHz)}})
		}
	}
	p.last = &state
}

func (s *Service) PassthroughStatus(ctx context.Context) (PassthroughState, error) {
	if s.Passthrough == nil {
		return (kernelPassthroughProvider{}).Status(ctx)
	}
	return s.Passthrough.Status(ctx)
}

func (s *Service) SetPassthrough(ctx context.Context, change PassthroughChange) (PassthroughState, error) {
	if s.Passthrough == nil {
		s.Events.AddMessage("critical", i18n.Message{Key: "events.outputFailed", Args: map[string]any{"p0": ErrPassthroughUnsupported}})
		return PassthroughState{State: "unsupported"}, ErrPassthroughUnsupported
	}
	return s.Passthrough.Set(ctx, change)
}

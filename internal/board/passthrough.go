package board

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/vim4-kvm/vim4-manager/internal/statefile"
)

var ErrPassthroughUnsupported = errors.New("当前内核不支持")

type PassthroughPreferences struct {
	Enabled bool `json:"enabled"`
	Audio   bool `json:"audio"`
}

type PassthroughChange struct {
	Enabled *bool `json:"enabled"`
	Audio   *bool `json:"audio"`
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
	Supported bool                `json:"supported"`
	Enabled   bool                `json:"enabled"`
	Audio     bool                `json:"audio"`
	State     string              `json:"state"`
	Input     *PassthroughInput   `json:"input,omitempty"`
	Monitor   *PassthroughMonitor `json:"monitor,omitempty"`
	Output    *PassthroughOutput  `json:"output,omitempty"`
}

// PassthroughProvider reports actual kernel state. Apply must return actual
// state, including on partial failure; the controller never invents success.
type PassthroughProvider interface {
	Status(context.Context) (PassthroughState, error)
	Apply(context.Context, PassthroughPreferences) (PassthroughState, error)
}

type kernelPassthroughProvider struct{}

func probePassthroughCapability() bool {
	// TODO: wire the capability contract from the main repository's HDMI
	// passthrough design document (being produced by the kernel task in
	// ../docs/). Replace this single probe once that document defines the ABI.
	// A kernel version alone is not evidence of the passthrough capability.
	return false
}

func (kernelPassthroughProvider) Status(context.Context) (PassthroughState, error) {
	return PassthroughState{Supported: probePassthroughCapability(), State: "unsupported"}, nil
}

func (p kernelPassthroughProvider) Apply(ctx context.Context, _ PassthroughPreferences) (PassthroughState, error) {
	state, err := p.Status(ctx)
	if err != nil {
		return state, err
	}
	return state, ErrPassthroughUnsupported
}

// Passthrough owns preferences and serializes kernel operations separately
// from status collection and the manager's privileged helper.
type Passthrough struct {
	mu       sync.Mutex
	provider PassthroughProvider
	path     string
	prefs    PassthroughPreferences
	events   *Events
	last     *PassthroughState
}

// OpenPassthrough restores saved preferences only when the provider supports
// them. Unsupported kernels preserve the file but report enabled=false.
// A nil provider selects the real, currently unsupported kernel provider.
func OpenPassthrough(ctx context.Context, dir string, provider PassthroughProvider, events *Events) (*Passthrough, error) {
	if provider == nil {
		provider = kernelPassthroughProvider{}
	}
	p := &Passthrough{provider: provider, path: filepath.Join(dir, "passthrough.json"), events: events}
	data, err := os.ReadFile(p.path)
	if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("读取透传设置失败：%w", err)
	}
	if err == nil {
		if err = json.Unmarshal(data, &p.prefs); err != nil {
			return nil, fmt.Errorf("透传设置无效：%w", err)
		}
		state, readErr := provider.Status(ctx)
		if readErr != nil {
			return nil, readErr
		}
		if state.Supported {
			state, err = provider.Apply(ctx, p.prefs)
			if err != nil {
				p.events.Add("critical", "透传失败：%s", err)
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
	if !p.mu.TryLock() {
		return PassthroughState{}, ErrBusy
	}
	defer p.mu.Unlock()
	before, err := p.provider.Status(ctx)
	if err != nil {
		return before, p.failure(err)
	}
	p.observe(before)
	if !before.Supported {
		return before, p.failure(ErrPassthroughUnsupported)
	}
	next := p.prefs
	if change.Enabled != nil {
		next.Enabled = *change.Enabled
	}
	if change.Audio != nil {
		next.Audio = *change.Audio
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
		actual, rollbackErr := p.provider.Apply(rollbackCtx, p.prefs)
		cancel()
		p.observe(actual)
		err = fmt.Errorf("保存透传设置失败：%w", err)
		if rollbackErr != nil {
			err = fmt.Errorf("%w；恢复失败：%v", err, rollbackErr)
		}
		return actual, p.failure(err)
	}
	p.prefs = next
	return state, nil
}

func (p *Passthrough) failure(err error) error {
	p.events.Add("critical", "透传失败：%s", err)
	return err
}

func passthroughRefresh(hz float64) string {
	return strings.TrimRight(strings.TrimRight(strconv.FormatFloat(hz, 'f', 2, 64), "0"), ".") + "Hz"
}

func (p *Passthrough) observe(state PassthroughState) {
	if p.last != nil && state.Enabled != p.last.Enabled {
		if state.Enabled {
			p.events.Add("good", "透传已开启")
		} else {
			p.events.Add("idle", "透传已关闭")
		}
	}
	if out := state.Output; state.State == "running" && out != nil && out.Scaled {
		old := p.last
		if old == nil || old.State != "running" || old.Output == nil || !old.Output.Scaled ||
			old.Output.Width != out.Width || old.Output.Height != out.Height || old.Output.RefreshHz != out.RefreshHz {
			p.events.Add("warning", "透传输出已缩放到 %d×%d %s", out.Width, out.Height, passthroughRefresh(out.RefreshHz))
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
		s.Events.Add("critical", "透传失败：%s", ErrPassthroughUnsupported)
		return PassthroughState{State: "unsupported"}, ErrPassthroughUnsupported
	}
	return s.Passthrough.Set(ctx, change)
}

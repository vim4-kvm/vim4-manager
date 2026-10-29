package board

import (
	"context"
	"encoding/json"
	"regexp"

	"github.com/vim4-kvm/vim4-manager/internal/i18n"
)

type EDIDPreset struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

type EDIDState struct {
	Presets      []EDIDPreset `json:"presets"`
	Selected     string       `json:"selected"`
	SavedName    string       `json:"savedName"`
	Active       string       `json:"active"`
	ActiveKnown  bool         `json:"activeKnown"`
	JetKVMSynced bool         `json:"jetkvmSynced"`
}

// LocalizeLabels preserves custom preset names and descriptions supplied by
// administrators. Only the three presets shipped with the manager are known.
func (state *EDIDState) LocalizeLabels(locale i18n.Locale) {
	for index := range state.Presets {
		preset := &state.Presets[index]
		key := map[string]string{
			"RTK-CONTROL":  "edid.rtkDescription",
			"VIM4-4K60":    "edid.4kDescription",
			"VIM4-1080P60": "edid.hdDescription",
		}[preset.ID]
		if key != "" {
			preset.Description = i18n.Message{Key: key}.Render(locale)
		}
	}
}

func (s *Service) EDID(ctx context.Context) (EDIDState, error) {
	var state EDIDState
	output, err := s.Run(ctx, "sudo", "-n", Helper, "edid-status")
	if err != nil {
		return state, i18n.Wrap(err, "edid.readFailed", map[string]any{"reason": err})
	}
	if err := json.Unmarshal([]byte(output), &state); err != nil {
		return state, i18n.Wrap(err, "edid.invalidState", map[string]any{"reason": err})
	}
	return state, nil
}

var edidID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

func (s *Service) SetEDID(ctx context.Context, id string) error {
	if !edidID.MatchString(id) {
		return i18n.New("edid.invalidId", nil)
	}
	return s.recordMessage(s.helper(ctx, "edid-select", id), i18n.Message{Key: "events.edidApplied", Args: map[string]any{"id": id}})
}

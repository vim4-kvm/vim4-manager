package board

import (
	"context"
	"strconv"

	"github.com/vim4-kvm/vim4-manager/internal/i18n"
)

// FanTriggers are the khadas-mcu auto-mode trigger temperatures in °C.
type FanTriggers struct {
	Low  int `json:"low"`
	Mid  int `json:"mid"`
	High int `json:"high"`
}

// DefaultFanTriggers mirror the kvim4/kvim4n device tree.
var DefaultFanTriggers = FanTriggers{Low: 60, Mid: 80, High: 100}

// SetFanCurve applies the triggers, switches the fan to automatic mode and
// keeps them for the next manager start. Limits match vim4-manager-helper.
func (s *Service) SetFanCurve(ctx context.Context, t FanTriggers) error {
	if t.Low < 35 || t.Low > 80 {
		return i18n.New("cooling.invalidStart", nil)
	}
	if t.Mid < t.Low+5 || t.Mid > 95 {
		return i18n.New("cooling.invalidMid", nil)
	}
	if t.High < t.Mid+5 || t.High > 100 {
		return i18n.New("cooling.invalidHigh", nil)
	}
	err := s.helper(ctx, "fan-curve", strconv.Itoa(t.Low), strconv.Itoa(t.Mid), strconv.Itoa(t.High))
	return s.recordMessage(err, i18n.Message{Key: "events.fanApplied", Args: map[string]any{"low": t.Low, "mid": t.Mid, "high": t.High}})
}

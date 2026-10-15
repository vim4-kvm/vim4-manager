package board

import (
	"context"
	"fmt"
	"strconv"
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
		return fmt.Errorf("起转温度需在 35–80 °C 之间")
	}
	if t.Mid < t.Low+5 || t.Mid > 95 {
		return fmt.Errorf("中速温度需比起转温度高至少 5 °C，且不超过 95 °C")
	}
	if t.High < t.Mid+5 || t.High > 100 {
		return fmt.Errorf("全速温度需比中速温度高至少 5 °C，且不超过 100 °C")
	}
	err := s.helper(ctx, "fan-curve", strconv.Itoa(t.Low), strconv.Itoa(t.Mid), strconv.Itoa(t.High))
	return s.record(err, "应用风扇曲线 %d / %d / %d °C", t.Low, t.Mid, t.High)
}

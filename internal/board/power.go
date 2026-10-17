package board

import (
	"context"
	"encoding/json"
	"time"
)

// Power separates the live VBUS threshold from the historical PD contract.
// Neither reports input current, board power consumption, or the active source.
type Power struct {
	VBUSPresent  *bool          `json:"vbusPresent"`
	BootContract *PowerContract `json:"bootContract"`
}

type PowerContract struct {
	VoltageV float64 `json:"voltageV"`
	CurrentA float64 `json:"currentA"`
}

func (s *Service) power(ctx context.Context) Power {
	s.powerMu.Lock()
	defer s.powerMu.Unlock()
	if time.Since(s.powerAt) < 5*time.Second {
		return s.powerState
	}
	ctx, cancel := context.WithTimeout(ctx, 7*time.Second)
	defer cancel()
	var state Power
	data, err := s.Run(ctx, "sudo", "-n", Helper, "power-status")
	if err == nil {
		if json.Unmarshal([]byte(data), &state) != nil {
			state = Power{}
		}
	}
	s.powerState, s.powerAt = state, time.Now()
	return state
}

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
	FirmwarePD   *FirmwarePD    `json:"firmwarePD,omitempty"`
}

// FirmwarePD is a historical U-Boot observation, independent of Linux bootstrap.
type FirmwarePD struct {
	PSReady              bool              `json:"psReady"`
	Flags                uint32            `json:"flags"`
	HardReset            bool              `json:"hardReset"`
	RequestFailed        bool              `json:"requestFailed"`
	TimedOut             bool              `json:"timedOut"`
	IOError              bool              `json:"ioError"`
	TypeCFallback        bool              `json:"typecFallback"`
	RP                   string            `json:"rp"`
	SourceRevision       *string           `json:"sourceRevision"`
	RequestRevision      *string           `json:"requestRevision"`
	SourceHeader         string            `json:"sourceHeader"`
	RequestHeader        string            `json:"requestHeader"`
	RDO                  string            `json:"rdo"`
	SelectedPosition     *int              `json:"selectedPosition"`
	SelectedType         *string           `json:"selectedType"`
	RequestedVoltageV    *float64          `json:"requestedVoltageV"`
	RequestedCurrentA    *float64          `json:"requestedCurrentA"`
	RequestedMaxCurrentA *float64          `json:"requestedMaxCurrentA"`
	RequestedMaxPowerW   *float64          `json:"requestedMaxPowerW"`
	RequestedPowerW      *float64          `json:"requestedPowerW"`
	PolicyVoltageV       float64           `json:"policyVoltageV"`
	PolicyCurrentA       float64           `json:"policyCurrentA"`
	Contract             *PowerContract    `json:"contract"`
	SourceCapabilities   []PowerCapability `json:"sourceCapabilities"`
}

type PowerCapability struct {
	Position    int      `json:"position"`
	Raw         string   `json:"raw"`
	Type        string   `json:"type"`
	MinVoltageV float64  `json:"minVoltageV,omitempty"`
	MaxVoltageV float64  `json:"maxVoltageV,omitempty"`
	MaxCurrentA *float64 `json:"maxCurrentA,omitempty"`
	MaxPowerW   *float64 `json:"maxPowerW,omitempty"`
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

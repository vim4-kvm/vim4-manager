package board

import (
	"context"
	"encoding/json"
	"github.com/vim4-kvm/vim4-manager/internal/i18n"
	"io"
	"net"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// WifiState reports the primary NetworkManager Wi-Fi device and its profiles.
type WifiState struct {
	Supported       bool         `json:"supported"`
	Enabled         bool         `json:"enabled"`
	HardwareEnabled bool         `json:"hardwareEnabled"`
	Device          string       `json:"device"`
	Mode            string       `json:"mode"`
	State           string       `json:"state"`
	ViaWifi         bool         `json:"viaWifi"`
	Current         *WifiCurrent `json:"current"`
	Saved           []WifiSaved  `json:"saved"`
	Hotspot         WifiHotspot  `json:"hotspot"`
}

type WifiCurrent struct {
	ID        string `json:"id"`
	SSID      string `json:"ssid"`
	Signal    int    `json:"signal"`
	Security  string `json:"security"`
	Frequency int    `json:"frequency"`
	IPv4      string `json:"ipv4"`
}

type WifiSaved struct {
	ID          string `json:"id"`
	SSID        string `json:"ssid"`
	Autoconnect bool   `json:"autoconnect"`
	Active      bool   `json:"active"`
}

type WifiStation struct {
	MAC      string `json:"mac"`
	IP       string `json:"ip"`
	Hostname string `json:"hostname"`
}

type WifiHotspot struct {
	Configured bool          `json:"configured"`
	Active     bool          `json:"active"`
	SSID       string        `json:"ssid"`
	Password   string        `json:"password"`
	Channel    int           `json:"channel"`
	Autostart  bool          `json:"autostart"`
	Address    string        `json:"address"`
	Clients    []WifiStation `json:"clients"`
}

type WifiNetwork struct {
	SSID      string `json:"ssid"`
	Signal    int    `json:"signal"`
	Security  string `json:"security"`
	Frequency int    `json:"frequency"`
	Saved     bool   `json:"saved"`
	Active    bool   `json:"active"`
}

type WifiConnectRequest struct {
	SSID     string `json:"ssid"`
	Password string `json:"password"`
	Hidden   bool   `json:"hidden"`
}

type WifiHotspotRequest struct {
	SSID      string `json:"ssid"`
	Password  string `json:"password"`
	Channel   int    `json:"channel"`
	Autostart bool   `json:"autostart"`
}

// helperOutput is read-only and deliberately bypasses the write mutex.
func (s *Service) helperOutput(ctx context.Context, args ...string) (string, error) {
	data, err := s.Run(ctx, "sudo", append([]string{"-n", Helper}, args...)...)
	if err != nil {
		return "", i18n.Wrap(err, "wifi.readFailed", map[string]any{"p0": networkHelperError(err)})
	}
	return data, nil
}

// helperInput shares the normal write lock. Secrets travel only on stdin.
// Recovery survives a lost wireless HTTP session, including its deadline.
func (s *Service) helperInput(ctx context.Context, input io.Reader, args ...string) error {
	if !s.mu.TryLock() {
		return ErrBusy
	}
	defer s.mu.Unlock()
	if len(args) > 0 && (args[0] == "wifi-connect" || args[0] == "wifi-activate" || args[0] == "wifi-mode" || args[0] == "wifi-hotspot") {
		ctx = context.WithoutCancel(ctx)
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	var err error
	if input == nil {
		_, err = s.Run(ctx, "sudo", append([]string{"-n", Helper}, args...)...)
	} else {
		run := s.Stream
		if run == nil {
			run = ExecStream
		}
		err = run(ctx, input, io.Discard, "sudo", append([]string{"-n", Helper}, args...)...)
	}
	if err != nil {
		if strings.Contains(err.Error(), "Another switch is in progress") {
			return ErrBusy
		}
		return i18n.Wrap(err, "wifi.operationFailed", map[string]any{"p0": networkHelperError(err)})
	}
	return nil
}

func (s *Service) Wifi(ctx context.Context) (WifiState, error) {
	data, err := s.helperOutput(ctx, "wifi-status")
	if err != nil {
		return WifiState{}, err
	}
	state := WifiState{Saved: []WifiSaved{}, Hotspot: WifiHotspot{Clients: []WifiStation{}}}
	if err := json.Unmarshal([]byte(data), &state); err != nil {
		return WifiState{}, i18n.New("wifi.invalidState", nil)
	}
	return state, nil
}

func (s *Service) WifiNetworks(ctx context.Context, rescan bool) ([]WifiNetwork, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	value := "0"
	if rescan {
		value = "1"
	}
	data, err := s.helperOutput(ctx, "wifi-scan", value)
	if err != nil {
		return nil, err
	}
	response := struct {
		Networks []WifiNetwork `json:"networks"`
	}{Networks: []WifiNetwork{}}
	if err := json.Unmarshal([]byte(data), &response); err != nil {
		return nil, i18n.New("wifi.invalidScan", nil)
	}
	return response.Networks, nil
}

// WifiUsesAddress compares the socket's local IP with all addresses on the
// primary Wi-Fi device, including IPv6 and addresses outside the DHCP subnet.
func (s *Service) WifiUsesAddress(ctx context.Context, device, address string) bool {
	if device == "" {
		return false
	}
	ip := net.ParseIP(strings.Split(address, "%")[0])
	if ip == nil {
		return false
	}
	data, err := s.Run(ctx, "ip", "-j", "address", "show", "dev", device)
	if err != nil {
		return false
	}
	var interfaces []struct {
		Addresses []struct {
			Local string `json:"local"`
		} `json:"addr_info"`
	}
	if json.Unmarshal([]byte(data), &interfaces) != nil {
		return false
	}
	for _, iface := range interfaces {
		for _, addr := range iface.Addresses {
			if ip.Equal(net.ParseIP(addr.Local)) {
				return true
			}
		}
	}
	return false
}

func validateWifiSSID(ssid string) error {
	if !utf8.ValidString(ssid) || len(ssid) < 1 || len(ssid) > 32 || strings.ContainsFunc(ssid, unicode.IsControl) {
		return i18n.New("wifi.invalidSSID", nil)
	}
	return nil
}

var wifiUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$`)
var wifiHexPSK = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

func validateWifiPassword(password string, hotspot bool) error {
	if password == "" || (!hotspot && wifiHexPSK.MatchString(password)) {
		return nil
	}
	if len(password) >= 8 && len(password) <= 63 && !strings.ContainsFunc(password, func(r rune) bool { return r < 32 || r > 126 }) {
		return nil
	}
	return i18n.New("wifi.invalidPassword", nil)
}

func validateWifiID(id string) error {
	if !wifiUUID.MatchString(id) {
		return i18n.New("wifi.invalidId", nil)
	}
	return nil
}

func (s *Service) SetWifi(ctx context.Context, enabled bool) error {
	value, key := "off", "events.wifiDisabled"
	if enabled {
		value, key = "on", "events.wifiEnabled"
	}
	return s.recordMessage(s.helperInput(ctx, nil, "wifi", value), i18n.Message{Key: key})
}

func (s *Service) ConnectWifi(ctx context.Context, request WifiConnectRequest) error {
	if err := validateWifiSSID(request.SSID); err != nil {
		return err
	}
	if err := validateWifiPassword(request.Password, false); err != nil {
		return err
	}
	data, _ := json.Marshal(request)
	return s.recordMessage(s.helperInput(ctx, strings.NewReader(string(data)), "wifi-connect"), i18n.Message{Key: "events.wifiConnected", Args: map[string]any{"name": request.SSID}})
}

func (s *Service) ActivateWifi(ctx context.Context, id string) error {
	if err := validateWifiID(id); err != nil {
		return err
	}
	return s.recordMessage(s.helperInput(ctx, nil, "wifi-activate", id), i18n.Message{Key: "events.wifiActivated"})
}

func (s *Service) DisconnectWifi(ctx context.Context) error {
	return s.recordMessage(s.helperInput(ctx, nil, "wifi-disconnect"), i18n.Message{Key: "events.wifiDisconnected"})
}

func (s *Service) ForgetWifi(ctx context.Context, id string) error {
	if err := validateWifiID(id); err != nil {
		return err
	}
	return s.recordMessage(s.helperInput(ctx, nil, "wifi-forget", id), i18n.Message{Key: "events.wifiForgotten"})
}

func (s *Service) SetWifiAutoconnect(ctx context.Context, id string, enabled bool) error {
	if err := validateWifiID(id); err != nil {
		return err
	}
	value := "no"
	if enabled {
		value = "yes"
	}
	key := "events.wifiAutoDisabled"
	if enabled {
		key = "events.wifiAutoEnabled"
	}
	return s.recordMessage(s.helperInput(ctx, nil, "wifi-autoconnect", id, value), i18n.Message{Key: key})
}

func (s *Service) SetWifiHotspot(ctx context.Context, request WifiHotspotRequest) error {
	if err := validateWifiSSID(request.SSID); err != nil {
		return err
	}
	if err := validateWifiPassword(request.Password, true); err != nil {
		return err
	}
	if request.Channel < 0 || request.Channel > 11 {
		return i18n.New("wifi.invalidChannel", nil)
	}
	data, _ := json.Marshal(request)
	return s.recordMessage(s.helperInput(ctx, strings.NewReader(string(data)), "wifi-hotspot"), i18n.Message{Key: "events.hotspotSaved", Args: map[string]any{"name": request.SSID}})
}

func (s *Service) SetWifiMode(ctx context.Context, mode string, force bool) error {
	if mode != "client" && mode != "hotspot" {
		return i18n.New("wifi.invalidMode", nil)
	}
	args := []string{"wifi-mode", mode}
	if force {
		args = append(args, "force")
	}
	key := "events.wifiClientMode"
	if mode == "hotspot" {
		key = "events.wifiHotspotMode"
	}
	return s.recordMessage(s.helperInput(ctx, nil, args...), i18n.Message{Key: key})
}

package board

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// HDMI describes the signal reported by the HDMI receiver, not the capture size.
type HDMI struct {
	Signal     bool    `json:"signal"`
	Width      int     `json:"width,omitempty"`
	Height     int     `json:"height,omitempty"`
	RefreshHz  float64 `json:"refreshHz,omitempty"`
	ColorSpace string  `json:"colorSpace,omitempty"`
	Depth      int     `json:"depth,omitempty"`
	Audio      bool    `json:"audio"`
	CaptureW   int     `json:"captureWidth,omitempty"`
	CaptureH   int     `json:"captureHeight,omitempty"`
}

// Hardware holds sysfs and procfs readings. Unreadable values stay zero.
type Hardware struct {
	Hostname  string  `json:"hostname"`
	Kernel    string  `json:"kernel"`
	UptimeSec float64 `json:"uptimeSeconds"`
	Load1     float64 `json:"load1"`
	CPUs      int     `json:"cpus"`
	MemTotal  int64   `json:"memTotalKiB"`
	MemAvail  int64   `json:"memAvailableKiB"`
	TempC     float64 `json:"tempC"`
	FanAuto   bool    `json:"fanAuto"`
	FanPct    int     `json:"fanPercent"`
	USB       string  `json:"usb"`
	HDMI      HDMI    `json:"hdmi"`
}

// ReadHardware reads from root, which is "/" on the board and a fixture in tests.
func ReadHardware(root string) Hardware {
	read := func(path string) string {
		data, _ := os.ReadFile(filepath.Join(root, path))
		return strings.TrimSpace(string(data))
	}
	var h Hardware
	h.Hostname = read("proc/sys/kernel/hostname")
	h.Kernel = read("proc/sys/kernel/osrelease")
	if fields := strings.Fields(read("proc/uptime")); len(fields) > 0 {
		h.UptimeSec, _ = strconv.ParseFloat(fields[0], 64)
	}
	if fields := strings.Fields(read("proc/loadavg")); len(fields) > 0 {
		h.Load1, _ = strconv.ParseFloat(fields[0], 64)
	}
	h.CPUs = strings.Count(read("proc/cpuinfo"), "processor\t:")
	for _, line := range strings.Split(read("proc/meminfo"), "\n") {
		key, value, _ := strings.Cut(line, ":")
		kib, _ := strconv.ParseInt(strings.TrimSuffix(strings.TrimSpace(value), " kB"), 10, 64)
		switch key {
		case "MemTotal":
			h.MemTotal = kib
		case "MemAvailable":
			h.MemAvail = kib
		}
	}
	// thermal_zone0 is soc_thermal on VIM4; the fan curve also follows it.
	if milli, err := strconv.Atoi(read("sys/class/thermal/thermal_zone0/temp")); err == nil {
		h.TempC = float64(milli) / 1000
	}
	h.FanAuto = afterColon(read("sys/class/fan/mode")) == "1"
	h.FanPct, _ = strconv.Atoi(afterColon(read("sys/class/fan/speed")))
	if states, _ := filepath.Glob(filepath.Join(root, "sys/class/udc/*/state")); len(states) > 0 {
		data, _ := os.ReadFile(states[0])
		h.USB = strings.TrimSpace(string(data))
	}
	h.HDMI = parseHDMI(read("sys/class/hdmirx/hdmirx0/info"))
	h.HDMI.CaptureW, h.HDMI.CaptureH = captureSize(read("etc/default/vim4-kvm-hdmi"))
	return h
}

// afterColon extracts the value of khadas-mcu lines such as "Fan speed: 15".
func afterColon(line string) string {
	_, value, _ := strings.Cut(line, ":")
	return strings.TrimSpace(value)
}

func parseHDMI(info string) HDMI {
	values := map[string]string{}
	for _, line := range strings.Split(info, "\n") {
		key, value, ok := strings.Cut(line, ":")
		key = strings.TrimSpace(key)
		// Keep the first occurrence; later sections reuse some field names.
		if _, seen := values[key]; ok && !seen {
			values[key] = strings.TrimSpace(value)
		}
	}
	number := func(key string) int {
		n, _ := strconv.Atoi(values[key])
		return n
	}
	h := HDMI{Width: number("Hactive"), Height: number("Vactive"), Depth: number("Color Depth")}
	_, h.ColorSpace, _ = strings.Cut(values["Color Space"], "-")
	// The receiver reports YUV420 timing at half the horizontal pixel count.
	if h.ColorSpace == "YUV420" {
		h.Width *= 2
	}
	h.RefreshHz = float64(number("Frame Rate")) / 100
	h.Signal = h.Width > 0 && h.Height > 0 && h.RefreshHz > 0
	h.Audio = values["audio receive data"] == "1"
	if !h.Signal {
		return HDMI{}
	}
	return h
}

// captureSize mirrors tools/hdmi-setup.sh defaults for the service override file.
func captureSize(defaults string) (int, int) {
	width, height := 3840, 2160
	for _, line := range strings.Split(defaults, "\n") {
		key, value, _ := strings.Cut(strings.TrimSpace(line), "=")
		n, err := strconv.Atoi(strings.Trim(value, `"'`))
		if err != nil {
			continue
		}
		switch key {
		case "HDMI_WIDTH":
			width = n
		case "HDMI_HEIGHT":
			height = n
		}
	}
	return width, height
}

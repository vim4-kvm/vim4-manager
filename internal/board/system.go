package board

import (
	"bufio"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
)

// Link is one physical network interface.
type Link struct {
	Name     string   `json:"name"`
	Wireless bool     `json:"wireless"`
	Up       bool     `json:"up"`
	SpeedMb  int      `json:"speedMbps,omitempty"`
	Addrs    []string `json:"addrs,omitempty"`
}

// Disk is the root filesystem usage.
type Disk struct {
	TotalBytes uint64 `json:"totalBytes"`
	FreeBytes  uint64 `json:"freeBytes"`
}

// Package is an installed component and its version.
type Package struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// physicalLinks lists interfaces backed by a device, skipping lo, dummy and
// tunnels, so the overview shows the cables and radios that carry video.
func physicalLinks(root string) []string {
	dirs, _ := filepath.Glob(filepath.Join(root, "sys/class/net/*"))
	var names []string
	for _, dir := range dirs {
		if _, err := os.Stat(filepath.Join(dir, "device")); err == nil {
			names = append(names, filepath.Base(dir))
		}
	}
	return names
}

func readLinks(root string, addrs map[string][]string) []Link {
	links := []Link{}
	for _, name := range physicalLinks(root) {
		dir := filepath.Join(root, "sys/class/net", name)
		state, _ := os.ReadFile(filepath.Join(dir, "operstate"))
		link := Link{Name: name, Up: strings.TrimSpace(string(state)) == "up", Addrs: addrs[name]}
		if _, err := os.Stat(filepath.Join(dir, "wireless")); err == nil {
			link.Wireless = true
		}
		// speed reads -1 or EINVAL on down links and on Wi-Fi.
		if data, err := os.ReadFile(filepath.Join(dir, "speed")); err == nil && link.Up {
			link.SpeedMb, _ = strconv.Atoi(strings.TrimSpace(string(data)))
			link.SpeedMb = max(link.SpeedMb, 0)
		}
		// usb0 is the gadget's NCM link to the controlled host; down when unused.
		if link.Up || link.Wireless || len(link.Addrs) > 0 || name == "eth0" {
			links = append(links, link)
		}
	}
	slices.SortFunc(links, func(a, b Link) int {
		if a.Up != b.Up {
			if a.Up {
				return -1
			}
			return 1
		}
		return strings.Compare(a.Name, b.Name)
	})
	return links
}

// parseAddrs reads `ip -o addr show` output: global IPv4 first, then global
// IPv6, without link-local or temporary privacy addresses.
func parseAddrs(output string) map[string][]string {
	v4, v6 := map[string][]string{}, map[string][]string{}
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		f := strings.Fields(scanner.Text())
		if len(f) < 4 || !slices.Contains(f, "global") || slices.Contains(f, "temporary") {
			continue
		}
		addr, _, _ := strings.Cut(f[3], "/")
		switch f[2] {
		case "inet":
			v4[f[1]] = append(v4[f[1]], addr)
		case "inet6":
			v6[f[1]] = append(v6[f[1]], addr)
		}
	}
	for name, list := range v6 {
		v4[name] = append(v4[name], list...)
	}
	return v4
}

// netBytes sums received and transmitted bytes over the physical links.
func netBytes(root string) (rx, tx uint64) {
	for _, name := range physicalLinks(root) {
		stats := filepath.Join(root, "sys/class/net", name, "statistics")
		r, _ := os.ReadFile(filepath.Join(stats, "rx_bytes"))
		t, _ := os.ReadFile(filepath.Join(stats, "tx_bytes"))
		rn, _ := strconv.ParseUint(strings.TrimSpace(string(r)), 10, 64)
		tn, _ := strconv.ParseUint(strings.TrimSpace(string(t)), 10, 64)
		rx += rn
		tx += tn
	}
	return rx, tx
}

func readDisk(root string) Disk {
	var st syscall.Statfs_t
	if err := syscall.Statfs(root, &st); err != nil {
		return Disk{}
	}
	return Disk{TotalBytes: st.Blocks * uint64(st.Bsize), FreeBytes: st.Bavail * uint64(st.Bsize)}
}

// installedPackages reads the vim4-* entries from the dpkg status database.
func installedPackages(status string) []Package {
	packages := []Package{}
	var name, version string
	installed := false
	flush := func() {
		if strings.HasPrefix(name, "vim4-") && installed {
			packages = append(packages, Package{name, version})
		}
		name, version, installed = "", "", false
	}
	for _, line := range strings.Split(status, "\n") {
		key, value, _ := strings.Cut(line, ": ")
		switch {
		case line == "":
			flush()
		case key == "Package":
			name = value
		case key == "Version":
			version = value
		case key == "Status":
			installed = strings.HasSuffix(value, " installed")
		}
	}
	flush()
	slices.SortFunc(packages, func(a, b Package) int { return strings.Compare(a.Name, b.Name) })
	return packages
}

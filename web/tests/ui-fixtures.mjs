import { readFileSync } from "node:fs";
// Use the shipped Go catalogs so mocked server labels cannot drift from production.
const catalogs = Object.fromEntries(["en", "zh-CN"].map(locale => {
  const file = locale === "en" ? "en.go" : "zh-CN.go";
  const source = readFileSync(new URL("../../internal/i18n/" + file, import.meta.url), "utf8");
  return [locale, Object.fromEntries([...source.matchAll(/^\s*"([^"]+)":\s*("(?:[^"\\]|\\.)*"),/gm)].map(match => [match[1], JSON.parse(match[2])]))];
}));
export function localizeResponse(path, value, cookie = "") {
  if (!value) return value;
  const locale = /(?:^|;\s*)vim4_lang=zh-CN(?:;|$)/.test(cookie) ? "zh-CN" : "en";
  const copy = catalogs[locale];
  const result = structuredClone(value);
  if (path === "/api/status") {
    for (const app of result.apps ?? []) app.description = copy["apps." + app.id] ?? app.description;
    for (const item of result.platform ?? []) {
      const key = /hdmi/.test(item.unit.name) ? "services.hdmi" : /gadget/.test(item.unit.name) ? "services.gadget" : /pd/.test(item.unit.name) ? "services.pd" : /cpufreq/.test(item.unit.name) ? "services.cpufreq" : undefined;
      if (key) item.name = copy[key];
    }
    for (const event of result.events ?? []) {
      if (!event.message) continue;
      event.text = copy[event.message.key].replace(/\{(\w+)\}/g, (_, name) => event.message.args?.[name] ?? `{${name}}`);
      delete event.message;
    }
  }
  if (path === "/api/updates") for (const item of result) if (item.package === "vim4-manager") item.name = copy["common.manager"];
  if (path === "/api/edid") for (const preset of result.presets ?? []) {
    const key = {"RTK-CONTROL":"edid.rtkDescription","VIM4-4K60":"edid.4kDescription","VIM4-1080P60":"edid.hdDescription"}[preset.id];
    if (key) preset.description = copy[key];
  }
  return result;
}
// Deterministic, offline API data shared by the before/after capture matrix.
export function fixtures(locale = "en") {
  const now = Date.now();
  const unit = (name, active = "active") => ({ name, loaded: true, active, sub: "running", enabled: "enabled", since: new Date(now - 3600e3).toISOString() });
  const media = { known: true, inserted: false, token: "media-token", name: "rescue.iso", cdrom: true, readOnly: true, connected: true, pikvm: false };
  const storage = { id: "home", name: "家庭 NAS", type: "smb", server: "192.168.50.2", share: "video", domain: "", username: "kvm", version: "auto", autoMount: true,
    error: "", stale: false, busy: false, insecure: false, mounted: true, state: "mounted", path: "/var/lib/vim4-kvm/nas/home", totalBytes: 4 * 2 ** 40, freeBytes: 2 ** 40, writable: true };
  const data = {
    errors: {},
    auth: { configured: true, authenticated: true, username: "admin", secure: false, setupAllowed: true, retryAfter: 0, hostname: "vim4" },
    status: {
      active: "onekvm", media,
      apps: ["nanokvm", "jetkvm", "onekvm", "pikvm"].map((id, i) => ({ id, name: ["NanoKVM", "JetKVM", "One-KVM", "PiKVM"][i], port: 8080, description: "", unit: unit(`vim4-${id}.service`, id === "onekvm" ? "active" : "inactive") })),
      platform: [{ name: "", restartable: true, unit: unit("vim4-hdmi.service") }, { name: "", restartable: true, unit: unit("vim4-usb-gadget.service") }, { name: "", restartable: false, unit: { ...unit("vim4-pd.service"), sub: "exited" } }],
      hardware: { hostname: "vim4", kernel: "7.3.0-vim4kvm-uhd1+", uptimeSeconds: 259200, load1: 0.3, cpus: 8,
        memTotalKiB: 8000000, memAvailableKiB: 6400000, tempC: 52.4, fanAuto: true, fanPercent: 30, fanTriggers: { low: 60, mid: 80, high: 100 },
        zones: [{ name: "soc", tempC: 52.4 }, { name: "ddr", tempC: 48.8 }], usb: "configured",
        hdmi: { signal: true, audio: true, width: 3840, height: 2160, captureWidth: 3840, captureHeight: 2160, refreshHz: 60, colorSpace: "YUV444", hdr: "HDR10-GAMMA_ST2084" }, hdrCurve: { white: 203, peak: 1000 } },
      system: { links: [{ name: "eth0", up: true, speedMbps: 1000, addrs: ["192.168.50.210"] }], disk: { totalBytes: 32 * 2 ** 30, freeBytes: 18 * 2 ** 30 }, packages: [{ name: "vim4-manager", version: "1.4.0+vim4.20261024.3" }] },
      power: { vbusPresent: true, bootContract: { voltageV: 12, currentA: 3 } }, history: [], events: [],
    },
    passthrough: { supported: true, enabled: true, audio: true, hdr: true, state: "running", audioState: "running",
      input: { width: 3840, height: 2160, refreshHz: 60, hdr: "HDR10", colorFormat: "YCbCr 4:4:4", audio: true },
      monitor: { name: "DELL U2723QE", maxWidth: 3840, maxHeight: 2160, maxRefreshHz: 60, hdr: true, audio: true },
      output: { width: 3840, height: 2160, refreshHz: 60, colorFormat: "YCbCr 4:2:2 limited", scaled: false, hdrToSdr: false } },
    edid: { presets: [{ id: "RTK-CONTROL", name: "RTK UHD HDR 4K60", description: "" }, { id: "VIM4-4K60", name: "VIM4 4K60", description: "" }, { id: "VIM4-1080P60", name: "VIM4 1080p60", description: "" }], selected: "RTK-CONTROL", savedName: "RTK UHD HDR 4K60", active: "RTK-CONTROL", activeKnown: true, jetkvmSynced: true },
    media: [{ id: "data/disk.img", name: "disk.img", source: "data", size: 2 ** 30, cdrom: false }, { id: "shared/rescue.iso", name: "rescue.iso", source: "shared", size: 700 * 2 ** 20, cdrom: true }],
    disks: [{ name: "disk.img", size: 2 ** 30, mtime: now / 1000, label: "VIM4KVM", freeBytes: 700 * 2 ** 20, attached: false, readOnly: false, editing: false, snapshots: [{ id: "snapshot-1", time: now / 1000 - 86400, size: 2 ** 30 }] }],
    files: { path: "/", stale: false, entries: [{ name: "drivers", dir: true, size: 0, mtime: now / 1000 }, { name: "readme.txt", dir: false, size: 1024, mtime: now / 1000 }] },
    storage: { known: true, tools: { smb: true, nfs: true }, storages: [storage] },
    nasdisk: { known: true, session: null, last: null, pending: [] },
    nasSession: { id: "nas-1", storage: "home", storageName: "家庭 NAS", path: "/工具", mode: "rw", label: "TOOLS", state: "scanning", scanned: 1234, files: 82, dirs: 8, volumeBytes: 8 * 2 ** 30, usedBytes: 2 ** 30, writtenBytes: 12 * 2 ** 20, skipped: [], skippedCount: 0, hostConnected: true, plan: null, progress: null, decision: null, error: "", startedAt: now / 1000 - 120 },
    wifi: { supported: true, enabled: true, hardwareEnabled: true, device: "wlan0", mode: "client", state: "connected", viaWifi: false,
      current: { id: "home-wifi", ssid: "Home", signal: 72, security: "WPA2", frequency: 2437, ipv4: "192.168.50.210/24" },
      saved: [{ id: "home-wifi", ssid: "Home", autoconnect: true, active: true }],
      hotspot: { configured: true, active: false, ssid: "VIM4-KVM-BC28", password: "k7mpq4xr2wzt", channel: 0, autostart: true, address: "10.42.0.1/24", clients: [] } },
    networks: [{ ssid: "Home", signal: 72, security: "WPA2", frequency: 2437, saved: true, active: true }, { ssid: "Office", signal: 55, security: "WPA2 WPA3", frequency: 5200, saved: false, active: false }, { ssid: "Cafe", signal: 40, security: "", frequency: 2412, saved: false, active: false }],
    tailscale: { installed: true, running: true, backendState: "Running", hostName: "vim4", dnsName: "vim4.tail1234.ts.net", ips: ["100.64.0.7"], tailnet: "user@example.com", controlURL: "https://controlplane.tailscale.com", version: "1.104.0", peers: 1, peersOnline: 1,
      devices: [{ id: "mac", hostName: "macbook", dnsName: "macbook.tail1234.ts.net", os: "macOS", ips: ["100.64.0.2"], online: true, lastSeen: "", relay: "sin", exitNode: false, active: true }] },
    kernel: { running: "7.3.0-vim4kvm-uhd1+", kernels: [{ id: "vendor", name: "Linux 5.15", release: "5.15.137", selected: false, available: true, error: "" }, { id: "mainline", name: "Linux 7.x", release: "7.3.0-vim4kvm-uhd1+", selected: true, available: true, error: "" }] },
    updates: [{ package: "vim4-manager", name: "", repo: "vim4-manager", installed: "1.4.0", latest: "1.4.1", available: true, selfService: false }, { package: "vim4-onekvm", name: "One-KVM", repo: "One-KVM", installed: "2.5.1", latest: "2.5.2", available: true, selfService: true }],
    account: { username: "admin", passwordChanged: new Date(now - 7 * 86400e3).toISOString(), sessions: [{ id: "current", address: "192.168.50.12", userAgent: "Mozilla/5.0 Macintosh Chrome/132", lastActive: new Date(now).toISOString(), current: true }, { id: "phone", address: "100.88.1.5", userAgent: "Mozilla/5.0 iPhone Safari/604", lastActive: new Date(now - 15 * 60e3).toISOString(), current: false }] },
  };
  const cookie = "vim4_lang=" + locale;
  data.status = localizeResponse("/api/status", data.status, cookie);
  data.edid = localizeResponse("/api/edid", data.edid, cookie);
  data.updates = localizeResponse("/api/updates", data.updates, cookie);
  return data;
}

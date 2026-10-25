import { redirectLogin } from "./auth";

export interface PassthroughState {
  supported: boolean;
  enabled: boolean;
  audio: boolean;
  audioState?: "off" | "starting" | "waiting" | "running" | "unavailable" | "error";
  state: "unsupported" | "off" | "starting" | "stopping" | "running" | "no-signal" | "no-monitor" | "protected";
  input?: { width: number; height: number; refreshHz: number; hdr: "SDR" | "HDR10" | "HLG"; colorFormat: string; audio: boolean };
  monitor?: { name: string; maxWidth: number; maxHeight: number; maxRefreshHz: number; hdr: boolean; audio: boolean };
  output?: { width: number; height: number; refreshHz: number; colorFormat: string; scaled: boolean; hdrToSdr: boolean };
}

export interface Unit {
  name: string;
  loaded: boolean;
  active: string;
  sub: string;
  enabled: string;
  since?: string;
}

export interface App {
  id: string;
  name: string;
  unit: Unit;
  description: string;
  port: number;
}

export interface Platform {
  name: string;
  unit: Unit;
  restartable: boolean;
}

export interface HDMI {
  signal: boolean;
  width?: number;
  height?: number;
  refreshHz?: number;
  colorSpace?: string;
  depth?: number;
  audio: boolean;
  captureWidth?: number;
  captureHeight?: number;
  hdr?: string;
}

export interface HDRCurve {
  white: number;
  peak: number;
}

// Mirrors tools/hdmi-setup.sh: BT.2408 reference white, 1000-nit highlights.
export const DEFAULT_HDR_CURVE: HDRCurve = { white: 203, peak: 1000 };
export interface Zone {
  name: string;
  tempC: number;
}

export interface CurvePoint {
  tempC: number;
  percent: number;
}

export interface Sample {
  t: number;
  cpu: number;
  cpuPowerW?: number | null;
  cpuPowerAvailable?: boolean;
  mem: number;
  tempC: number;
  fan: number;
  rxBps: number;
  txBps: number;
}

export interface Link {
  name: string;
  wireless: boolean;
  up: boolean;
  speedMbps?: number;
  addrs?: string[];
}

export interface System {
  links: Link[];
  disk: { totalBytes: number; freeBytes: number };
  packages: { name: string; version: string }[];
}

export interface BoardEvent {
  t: number;
  tone: "good" | "warning" | "critical" | "idle";
  text: string;
}

export interface FanTriggers {
  low: number;
  mid: number;
  high: number;
}

export interface Hardware {
  hostname: string;
  kernel: string;
  uptimeSeconds: number;
  load1: number;
  cpus: number;
  memTotalKiB: number;
  memAvailableKiB: number;
  tempC: number;
  zones: Zone[];
  fanAuto: boolean;
  fanPercent: number;
  fanCurve?: CurvePoint[];
  fanTriggers?: FanTriggers;
  usb: string;
  hdmi: HDMI;
  hdrCurve: HDRCurve;
}

export interface PowerCapability {
  position: number; raw: string; type: string;
  minVoltageV?: number; maxVoltageV?: number; maxCurrentA?: number; maxPowerW?: number;
}

export interface FirmwarePD {
  psReady: boolean; flags: number; hardReset: boolean; requestFailed: boolean;
  timedOut: boolean; ioError: boolean; typecFallback: boolean; rp: string;
  sourceRevision: string | null; requestRevision: string | null;
  sourceHeader: string; requestHeader: string; rdo: string;
  selectedPosition: number | null; selectedType: string | null;
  requestedVoltageV: number | null; requestedCurrentA: number | null; requestedPowerW: number | null;
  requestedMaxCurrentA: number | null; requestedMaxPowerW: number | null;
  policyVoltageV: number; policyCurrentA: number;
  contract: { voltageV: number; currentA: number } | null;
  sourceCapabilities: PowerCapability[];
}

export interface Status {
  passthrough?: PassthroughState;
  power?: {
    vbusPresent: boolean | null;
    bootContract: { voltageV: number; currentA: number } | null;
    firmwarePD?: FirmwarePD;
    lastContract?: {
      voltageV: number; currentA: number; usbComm: boolean; rdo: string;
      origin: "linux" | "firmware"; bootId: string; establishedAt: string;
    };
  };
  media?: Media;
  active: string;
  apps: App[];
  platform: Platform[];
  hardware: Hardware;
  system: System;
  history: Sample[];
  events: BoardEvent[];
}

export interface Media {
  token?: string;
  known: boolean;
  inserted: boolean;
  name: string;
  readOnly: boolean;
  cdrom: boolean;
  connected: boolean;
  pikvm: boolean;
  nasdisk?: { storage: string; storageName: string; path: string; mode: "ro" | "rw" };
}

export interface MediaImage {
  id: string; name: string; source: string; size: number; cdrom: boolean;
}

export async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    signal,
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) redirectLogin();
  if (!response.ok) throw new Error(data.error ?? `请求失败（${response.status}）`);
  return data as T;
}

export const getStatus = () => request<Status>("/api/status");
export const selectApp = (app: string) => request("/api/select", { app });
export const restartUnit = (unit: string) => request("/api/restart", { unit });
export const setHDRCurve = (curve: HDRCurve) => request("/api/hdr-curve", curve);
export const previewHDRCurve = (curve: HDRCurve) => request("/api/hdr-curve/preview", curve);
export const setFanCurve = (triggers: FanTriggers) => request("/api/fan-curve", triggers);

export interface Update {
  package: string;
  name: string;
  repo: string;
  installed: string;
  latest?: string;
  available: boolean;
  selfService: boolean;
  error?: string;
}

export const getUpdates = (signal?: AbortSignal) => request<Update[]>("/api/updates", undefined, signal);
export const installUpdate = (pkg: string) => request("/api/updates", { package: pkg });

export interface DiskSnapshot {
  id: string;
  time: number;
  size: number;
}

export interface Disk {
  name: string;
  size: number;
  mtime: number;
  label: string | null;
  freeBytes: number | null;
  attached: boolean;
  readOnly: boolean;
  editing: boolean;
  snapshots: DiskSnapshot[];
}

export interface DiskEntry {
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
}

export interface DiskListing {
  path: string;
  stale: boolean;
  entries: DiskEntry[];
}

const query = (params: Record<string, string>) => new URLSearchParams(params).toString();
export const getDisks = (signal?: AbortSignal) => request<Disk[]>("/api/disks", undefined, signal);
export const listDiskFiles = (disk: string, path: string, signal?: AbortSignal) =>
  request<DiskListing>(`/api/disks/files?${query({ disk, path })}`, undefined, signal);
export const diskFileURL = (disk: string, path: string) => `/api/disks/file?${query({ disk, path })}`;
export const diskImageURL = (disk: string) => `/api/disks/image?${query({ disk })}`;

// XHR rather than fetch: upload progress is not observable through fetch.
export function uploadDiskFile(disk: string, path: string, file: File, overwrite: boolean,
  onProgress: (sent: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("已取消上传", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/disks/file?${query({ disk, path, overwrite: overwrite ? "1" : "0" })}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Vim4-Upload", "1");
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => {
      if (xhr.status === 401) redirectLogin();
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = `上传失败（${xhr.status}）`;
      try { message = JSON.parse(xhr.responseText).error ?? message; } catch { /* non-JSON proxy error */ }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("上传中断，请检查网络连接"));
    xhr.onabort = () => reject(new DOMException("已取消上传", "AbortError"));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

export interface WifiConnection {
  id: string;
  ssid: string;
  signal: number;
  security: string;
  frequency: number;
  ipv4: string;
}

export interface SavedWifi {
  id: string;
  ssid: string;
  autoconnect: boolean;
  active: boolean;
}

export interface HotspotClient {
  mac: string;
  ip: string;
  hostname: string;
}

export interface Hotspot {
  configured: boolean;
  active: boolean;
  ssid: string;
  password: string;
  channel: number;
  autostart: boolean;
  address: string;
  clients: HotspotClient[];
}

export interface WifiState {
  supported: boolean;
  enabled: boolean;
  hardwareEnabled: boolean;
  device?: string;
  mode?: "client" | "hotspot" | "off";
  state?: "connected" | "connecting" | "disconnected" | "unavailable";
  viaWifi?: boolean;
  current?: WifiConnection | null;
  saved?: SavedWifi[];
  hotspot?: Hotspot;
}

export interface WifiNetwork {
  ssid: string;
  signal: number;
  security: string;
  frequency: number;
  saved: boolean;
  active: boolean;
}

export interface HotspotConfig {
  ssid: string;
  password: string;
  channel: number;
  autostart: boolean;
}

// Mode changes and connects can block for the helper's 45 s connect and 30 s fallback windows.
export const wifiWrite = (path: string, body: unknown) => request(`/api/wifi${path}`, body, AbortSignal.timeout(100000));

export type StorageType = "smb" | "nfs";

export interface StorageConfig {
  id?: string;
  name: string;
  type: StorageType;
  server: string;
  share: string;
  domain: string;
  username: string;
  version: string;
  autoMount: boolean;
}

export interface Storage extends Required<StorageConfig> {
  mounted: boolean;
  state: "mounted" | "unmounted" | "mounting" | "error";
  error: string;
  path: string;
  totalBytes: number | null;
  freeBytes: number | null;
  stale: boolean;
  writable: boolean | null;
  busy: boolean;
  insecure: boolean;
}

export interface StorageState {
  known: boolean;
  tools: { smb: boolean; nfs: boolean };
  storages: Storage[];
}

export interface StorageTest {
  ok: boolean;
  totalBytes?: number;
  freeBytes?: number;
  writable?: boolean;
  elapsedMs?: number;
  error?: string;
}

export const storageWrite = <T = unknown>(path: string, body: unknown) =>
  request<T>(`/api/storage${path}`, body, AbortSignal.timeout(60000));

export interface NasDiskCounts {
  mkdirs: number;
  writes: number;
  renames: number;
  deletes: number;
  ignored: number;
  conflicts: number;
}

export interface NasDiskSession {
  id: string;
  storage: string;
  storageName: string;
  path: string;
  mode: "ro" | "rw";
  label: string;
  state: "scanning" | "attaching" | "attached" | "parsing" | "committing" | "needs-decision" | "failed";
  scanned: number;
  files: number;
  dirs: number;
  volumeBytes: number;
  usedBytes: number;
  writtenBytes: number;
  skipped: { path: string; reason: string }[];
  skippedCount: number;
  hostConnected: boolean;
  nasStalled?: boolean;
  plan: NasDiskCounts | null;
  progress: { done: number; total: number; bytesDone: number; bytesTotal: number; current: string } | null;
  decision: { reason: string; canForce: boolean } | null;
  error: string;
  detail?: string;
  startedAt: number;
}

export interface NasDiskLast {
  id: string;
  storageName: string;
  path: string;
  mode: "ro" | "rw";
  result: "committed" | "discarded" | "unchanged" | "failed" | "cancelled";
  summary: NasDiskCounts;
  conflicts: { path: string; copy: string }[];
  error: string;
  detail?: string;
  finishedAt: number;
  trash?: { bytes: number; files: number } | null;
}

export interface NasDiskState {
  known: boolean;
  session: NasDiskSession | null;
  last: NasDiskLast | null;
  pending: { id: string; storage: string; storageName: string; path: string; writtenBytes: number; startedAt: number; journal: boolean }[];
}

export const nasDiskWrite = (path: string, body: unknown) => request(`/api/nasdisk${path}`, body, AbortSignal.timeout(60000));

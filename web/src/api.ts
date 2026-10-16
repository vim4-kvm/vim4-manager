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

export interface Status {
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
  known: boolean;
  inserted: boolean;
  name: string;
  readOnly: boolean;
  cdrom: boolean;
  connected: boolean;
  pikvm: boolean;
}

export async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    signal,
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
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

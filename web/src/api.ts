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

export interface Hardware {
  hostname: string;
  kernel: string;
  uptimeSeconds: number;
  load1: number;
  cpus: number;
  memTotalKiB: number;
  memAvailableKiB: number;
  tempC: number;
  fanAuto: boolean;
  fanPercent: number;
  usb: string;
  hdmi: HDMI;
  hdrCurve: HDRCurve;
}

export interface Status {
  active: string;
  apps: App[];
  platform: Platform[];
  hardware: Hardware;
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
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

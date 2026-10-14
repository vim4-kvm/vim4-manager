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
}

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
  usb: string;
  hdmi: HDMI;
}

export interface Status {
  active: string;
  apps: App[];
  platform: Platform[];
  hardware: Hardware;
  history: Sample[];
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

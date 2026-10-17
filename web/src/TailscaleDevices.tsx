import { useState } from "react";
import { request } from "./api";
import { CopyButton } from "./Icons";

export interface TailscaleDevice {
  id: string;
  hostName: string;
  dnsName: string;
  os: string;
  ips: string[];
  online: boolean;
  lastSeen: string;
  relay: string;
  exitNode: boolean;
  active: boolean;
}

interface PingResult {
  reachable: boolean;
  path: "direct" | "derp" | "peer-relay" | "";
  via: string;
  latencyMs: number[];
  lost: number;
  sent: number;
}

type PingState = { pending: true } | { pending: false; result?: PingResult; error?: string };

function lastSeen(value: string) {
  if (!value) return "";
  const minutes = (Date.now() - Date.parse(value)) / 60000;
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} 分钟前在线`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} 小时前在线`;
  return `${Math.round(minutes / 1440)} 天前在线`;
}

function pingSummary(result: PingResult) {
  if (!result.reachable) return { tone: "critical", text: `无响应（${result.sent} 次全部超时）` };
  const ms = result.latencyMs;
  const avg = ms.reduce((a, b) => a + b, 0) / ms.length;
  const latency = `${avg < 10 ? avg.toFixed(1) : Math.round(avg)} ms`;
  const loss = result.lost ? `，丢失 ${result.lost}/${result.sent}` : "";
  if (result.path === "direct") return { tone: "good", text: `直连，${latency}${loss}` };
  if (result.path === "peer-relay") return { tone: "warning", text: `经节点中继，${latency}${loss}` };
  return {
    tone: "warning",
    text: `经 DERP 中继${result.via ? ` ${result.via}` : ""}，${latency}${loss}。中继会明显增加 KVM 延迟`,
  };
}

function DeviceRow({ device, writable }: { device: TailscaleDevice; writable: boolean }) {
  const [ping, setPing] = useState<PingState>();
  const ip = device.ips.find((a) => !a.includes(":")) ?? device.ips[0];
  async function test() {
    setPing({ pending: true });
    try {
      const result = await request<PingResult>("/api/tailscale/ping", { ip }, AbortSignal.timeout(35000));
      setPing({ pending: false, result });
    } catch (e) {
      setPing({ pending: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const summary = ping && !ping.pending && ping.result ? pingSummary(ping.result) : undefined;
  return (
    <li className="ts-device">
      <span className={`lamp ${device.online ? "status-good" : ""}`} aria-hidden="true" />
      <div className="ts-device-main">
        <div className="ts-device-name">
          <strong>{device.hostName}</strong>
          {device.os && <span className="tag tag-quiet">{device.os}</span>}
          {device.exitNode && <span className="tag">出口节点</span>}
        </div>
        <div className="ts-device-meta">
          {ip && <span className="mono">{ip}</span>}
          <span className="muted">{device.online ? "在线" : lastSeen(device.lastSeen) || "离线"}</span>
        </div>
        {ping?.pending && (
          <p className="ts-ping muted" role="status">
            <span className="spinner" aria-hidden="true" />
            正在测试 4 次…
          </p>
        )}
        {summary && (
          <p className={`ts-ping ts-ping-${summary.tone}`} role="status">
            {summary.text}
          </p>
        )}
        {ping && !ping.pending && ping.error && (
          <p className="ts-ping ts-ping-critical" role="alert">
            {ping.error}
          </p>
        )}
      </div>
      <div className="ts-device-actions">
        {ip && <CopyButton text={ip} label={`${device.hostName} 的地址`} />}
        {ip && (
          <button
            type="button"
            className="button small"
            aria-label={`测试到 ${device.hostName} 的连接`}
            disabled={ping?.pending || !writable}
            onClick={() => void test()}
          >
            测试连接
          </button>
        )}
      </div>
    </li>
  );
}

export function TailscaleDevices({ devices, writable }: { devices: TailscaleDevice[]; writable: boolean }) {
  const [showOffline, setShowOffline] = useState(false);
  const online = devices.filter((d) => d.online);
  const offline = devices.filter((d) => !d.online);
  return (
    <div className="ts-devices">
      <div className="ts-devices-head">
        <h4>tailnet 中的其他设备</h4>
        <span className="muted num">
          {online.length} 台在线 / 共 {devices.length} 台
        </span>
      </div>
      {devices.length === 0 ? (
        <p className="muted ts-empty">tailnet 中还没有其他设备。</p>
      ) : (
        <>
          {online.length > 0 ? (
            <ul className="ts-device-list" aria-label="在线设备">
              {online.map((d) => (
                <DeviceRow key={d.id} device={d} writable={writable} />
              ))}
            </ul>
          ) : (
            <p className="muted ts-empty">没有其他在线设备。</p>
          )}
          {offline.length > 0 && (
            <button
              type="button"
              className="link ts-offline-toggle"
              aria-expanded={showOffline}
              onClick={() => setShowOffline(!showOffline)}
            >
              {showOffline ? "收起离线设备" : `显示 ${offline.length} 台离线设备`}
            </button>
          )}
          {showOffline && (
            <ul className="ts-device-list" aria-label="离线设备">
              {offline.map((d) => (
                <DeviceRow key={d.id} device={d} writable={writable} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

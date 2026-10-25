import { Network } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { StatusDot } from "@/components/StatusDot";
import { InlineError } from "@/components/InlineError";
import { AnimatedList } from "@/components/AnimatedList";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { request } from "./api";
import { CopyButton } from "@/components/CopyButton";

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
    <div className="flex min-w-0 flex-wrap items-center gap-3 py-3">
      <StatusDot tone={device.online ? "good" : "idle"} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2 [&_strong]:break-all">
          <strong>{device.hostName}</strong>
          {device.os && <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground">{device.os}</span>}
          {device.exitNode && <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium">出口节点</span>}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          {ip && <span className="font-mono break-all">{ip}</span>}
          <span className="text-muted-foreground">{device.online ? "在线" : lastSeen(device.lastSeen) || "离线"}</span>
        </div>
        {ping?.pending && (
          <p className="text-xs text-muted-foreground" role="status">
            <span className="inline-block size-4 shrink-0 motion-safe:animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
            正在测试 4 次…
          </p>
        )}
        {summary && (
          <p className={`text-xs ${summary.tone === "critical" ? "text-destructive" : summary.tone === "warning" ? "text-warning-foreground" : "text-success-foreground"}`} role="status">
            {summary.text}
          </p>
        )}
        {ping && !ping.pending && ping.error && (
          <InlineError>
            {ping.error}
          </InlineError>
        )}
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {ip && <CopyButton text={ip} label={`${device.hostName} 的地址`} />}
        {ip && (
          <Button size="sm" variant="outline"
            type="button"

            aria-label={`测试到 ${device.hostName} 的连接`}
            disabled={ping?.pending || !writable}
            onClick={() => void test()}
          >
            测试连接
          </Button>
        )}
      </div>
    </div>
  );
}

export function TailscaleDevices({ devices, writable }: { devices: TailscaleDevice[]; writable: boolean }) {
  const [showOffline, setShowOffline] = useState(false);
  const online = devices.filter((d) => d.online);
  const offline = devices.filter((d) => !d.online);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3 [&_h4]:font-medium">
        <h4>tailnet 中的其他设备</h4>
        <span className="text-muted-foreground tabular-nums">
          {online.length} 台在线 / 共 {devices.length} 台
        </span>
      </div>
      {devices.length === 0 ? (
        <EmptyState icon={Network}>tailnet 中还没有其他设备。</EmptyState>
      ) : (
        <>
          {online.length > 0 ? (
            <AnimatedList className="flex min-w-0 flex-col divide-y" label="在线设备" items={online} getKey={(d) => d.id}>{(d) => <DeviceRow device={d} writable={writable} />}</AnimatedList>
          ) : (
            <EmptyState icon={Network}>没有其他在线设备。</EmptyState>
          )}
          {offline.length > 0 && (
            <Button variant="outline"
              type="button"
              className="text-primary self-start border-0 bg-transparent text-xs text-muted-foreground"
              aria-expanded={showOffline}
              onClick={() => setShowOffline(!showOffline)}
            >
              {showOffline ? "收起离线设备" : `显示 ${offline.length} 台离线设备`}
            </Button>
          )}
          {showOffline && (
            <AnimatedList className="flex min-w-0 flex-col divide-y" label="离线设备" items={offline} getKey={(d) => d.id}>{(d) => <DeviceRow device={d} writable={writable} />}</AnimatedList>
          )}
        </>
      )}
    </div>
  );
}

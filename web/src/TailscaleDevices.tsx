import { t, useLocale } from "@/i18n";
import { number, relativeTime } from "@/i18n/format";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/Spinner";
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
  const relative = minutes < 60 ? relativeTime(-Math.max(1, Math.round(minutes)), "minute")
    : minutes < 48 * 60 ? relativeTime(-Math.round(minutes / 60), "hour") : relativeTime(-Math.round(minutes / 1440), "day");
  return t("tailscaleDevices.lastSeen", { time: relative });
}

function pingSummary(result: PingResult) {
  if (!result.reachable) return { tone: "critical", text: t("tailscaleDevices.noResponseAllProbesTimedOut", { count: result.sent }) };
  const ms = result.latencyMs;
  const avg = ms.reduce((a, b) => a + b, 0) / ms.length;
  const latency = number(avg, { minimumFractionDigits: avg < 10 ? 1 : 0, maximumFractionDigits: avg < 10 ? 1 : 0 });
  const params = { latency, lost: result.lost, sent: result.sent, via: result.via };
  if (result.path === "direct") return { tone: "good", text: result.lost
    ? t("tailscaleDevices.directLoss", params) : t("tailscaleDevices.directPing", { latency }) };
  if (result.path === "peer-relay") return { tone: "warning", text: result.lost
    ? t("tailscaleDevices.peerLoss", params) : t("tailscaleDevices.peerPing", { latency }) };
  return {
    tone: "warning",
    text: result.lost ? t("tailscaleDevices.derpLoss", params) : t("tailscaleDevices.derpPing", params),
  };
}

function DeviceRow({ device, writable }: { device: TailscaleDevice; writable: boolean }) {
  useLocale();
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
          {device.os && <Badge variant="secondary">{device.os}</Badge>}
          {device.exitNode && <Badge variant="outline">{t("tailscaleDevices.exitNode")}</Badge>}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          {ip && <span className="font-mono break-all">{ip}</span>}
          <span className="text-muted-foreground">{device.online ? t("tailscaleDevices.online") : lastSeen(device.lastSeen) || t("tailscaleDevices.offline")}</span>
        </div>
        {ping?.pending && (
          <p className="text-xs text-muted-foreground" role="status">
            <Spinner />
            {t("tailscaleDevices.sendingProbes")}</p>
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
        {ip && <CopyButton text={ip} label={t("tailscaleDevices.address", { p0: String(device.hostName) })} />}
        {ip && (
          <Button variant="outline"
            type="button"

            aria-label={t("tailscaleDevices.testConnectionTo", { p0: String(device.hostName) })}
            disabled={ping?.pending || !writable}
            onClick={() => void test()}
          >
            {t("tailscaleDevices.testConnection")}</Button>
        )}
      </div>
    </div>
  );
}

export function TailscaleDevices({ devices, writable }: { devices: TailscaleDevice[]; writable: boolean }) {
  useLocale();
  const [showOffline, setShowOffline] = useState(false);
  const online = devices.filter((d) => d.online);
  const offline = devices.filter((d) => !d.online);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3 [&_h4]:font-medium">
        <h4>{t("tailscaleDevices.otherTailnetDevices")}</h4>
        <span className="text-muted-foreground tabular-nums">
          {t("tailscaleDevices.onlineCount", { online: online.length, total: devices.length })}</span>
      </div>
      {devices.length === 0 ? (
        <EmptyState icon={Network}>{t("tailscaleDevices.noOtherDevicesInThisTailnet")}</EmptyState>
      ) : (
        <>
          {online.length > 0 ? (
            <AnimatedList className="flex min-w-0 flex-col divide-y" label={t("tailscale.onlineDevices")} items={online} getKey={(d) => d.id}>{(d) => <DeviceRow device={d} writable={writable} />}</AnimatedList>
          ) : (
            <EmptyState icon={Network}>{t("tailscaleDevices.noOtherDevicesOnline")}</EmptyState>
          )}
          {offline.length > 0 && (
            <Button variant="link" size="inline"
              type="button"
              className="self-start"
              aria-expanded={showOffline}
              onClick={() => setShowOffline(!showOffline)}
            >
              {showOffline ? t("tailscaleDevices.hideOfflineDevices") : t("tailscaleDevices.showOfflineCount", { count: offline.length })}
            </Button>
          )}
          {showOffline && (
            <AnimatedList className="flex min-w-0 flex-col divide-y" label={t("tailscaleDevices.offlineDevices")} items={offline} getKey={(d) => d.id}>{(d) => <DeviceRow device={d} writable={writable} />}</AnimatedList>
          )}
        </>
      )}
    </div>
  );
}

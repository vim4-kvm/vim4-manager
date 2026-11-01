import type { Unit } from "@/api";
import type { Tone } from "@/components/StatusDot";
import { getLocale, t } from "@/i18n";
import { dateTime, durationPart, number, time } from "@/i18n/format";
import { useHttpsStore } from "@/stores/https";

export function unitTone(unit: Unit): Tone {
  if (!unit.loaded) return "idle";
  if (unit.active === "active") return "good";
  if (unit.active === "failed") return "critical";
  if (unit.active === "activating" || unit.active === "deactivating" || unit.active === "reloading") return "warning";
  return "idle";
}

export function unitLabel(unit: Unit): string {
  if (!unit.loaded) return t("units.notInstalled");
  switch (unit.active) {
    case "active":
      // Oneshot board units stay "active (exited)" after doing their work.
      return unit.sub === "exited" ? t("units.completed") : t("units.running");
    case "failed":
      return t("units.failed");
    case "activating":
      return t("units.starting");
    case "deactivating":
      return t("units.stopping");
    default:
      return t("units.stopped");
  }
}

export function duration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts = [[days, "day"], [hours, "hour"], [minutes, "minute"]] as const;
  const shown = parts.filter(([value]) => value > 0).slice(0, 2);
  return (shown.length ? shown : [[0, "minute"]] as const).map(([value, unit]) => durationPart(value, unit)).join(getLocale() === "en" ? " " : "");
}

export function since(unit: Unit, now: number): string | undefined {
  if (!unit.since || unit.active !== "active") return undefined;
  return duration(Math.max(0, (now - Date.parse(unit.since)) / 1000));
}

export function tempTone(c: number): Tone {
  return c >= 85 ? "critical" : c >= 70 ? "warning" : "good";
}

type Page = Pick<Location, "protocol" | "hostname">;

/**
 * The KVM gateway port matching this page's scheme: the plain-HTTP app port,
 * or on an HTTPS page the gateway's TLS listener (8443 unless the HTTPS status says otherwise).
 */
export function kvmPort(port: number, page: Page = location): number {
  if (page.protocol !== "https:") return port;
  const kvm = useHttpsStore.getState().https?.urls.kvm;
  return kvm ? Number(new URL(kvm).port || 443) : 8443;
}

export function kvmURL(port: number, app: string, page: Page = location): string {
  return `${page.protocol}//${page.hostname}:${kvmPort(port, page)}/?kvm=${encodeURIComponent(app)}`;
}

export const celsius = (v: number) => `${number(v, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} °C`;

// Receiver values include HDR10-GAMMA_ST2084, HDR10-GAMMA_HLG and HDR10Plus-VSIF.
export function hdrLabel(status?: string): string | undefined {
  if (!status) return undefined;
  if (status === "SDR") return "SDR";
  if (status.includes("HLG")) return "HLG";
  if (status.includes("Plus")) return "HDR10+";
  return status.startsWith("HDR") ? "HDR10" : status;
}

export function clockTime(t: number, now: number): string {
  const d = new Date(t);
  return new Date(now).toDateString() === d.toDateString() ? time(d) : dateTime(d);
}

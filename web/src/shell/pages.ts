import {
  Cpu, Disc3, Fan, HardDrive, LayoutDashboard, MonitorPlay, MonitorUp, RefreshCw, Server, UserRound, Video, Wifi,
  type LucideIcon,
} from "lucide-react";
import type { PassthroughState, Status } from "@/api";
import type { Tone } from "@/components/StatusDot";
import { celsius, tempTone, unitTone } from "@/lib/units";
import { t } from "@/i18n";

export type PageId = "overview" | "apps" | "media" | "disks" | "storage" | "video" | "output" | "cooling" | "network" | "services" | "updates" | "account";

export interface PageMeta {
  id: PageId;
  title: string;
  description?: string;
  icon: LucideIcon;
  group: "console" | "device" | "system";
  wide?: boolean;
}

export const PAGE_GROUPS = ["console", "device", "system"] as const;

export const PAGES: PageMeta[] = [
  { id: "overview", get title() { return t("nav.overview"); }, get description() { return t("nav.overviewHelp"); }, icon: LayoutDashboard, group: "console", wide: true },
  { id: "apps", get title() { return t("nav.apps"); }, get description() { return t("nav.appsHelp"); }, icon: MonitorPlay, group: "console", wide: true },
  { id: "media", get title() { return t("nav.media"); }, get description() { return t("nav.mediaHelp"); }, icon: Disc3, group: "console", wide: true },
  { id: "disks", get title() { return t("nav.disks"); }, get description() { return t("nav.disksHelp"); }, icon: HardDrive, group: "console", wide: true },
  { id: "storage", get title() { return t("nav.storage"); }, get description() { return t("nav.storageHelp"); }, icon: Server, group: "console", wide: true },
  { id: "video", get title() { return t("nav.video"); }, get description() { return t("nav.videoHelp"); }, icon: Video, group: "device", wide: true },
  { id: "output", get title() { return t("nav.output"); }, get description() { return t("nav.outputHelp"); }, icon: MonitorUp, group: "device", wide: true },
  { id: "cooling", get title() { return t("nav.cooling"); }, get description() { return t("nav.coolingHelp"); }, icon: Fan, group: "device", wide: true },
  { id: "network", get title() { return t("nav.network"); }, get description() { return t("nav.networkHelp"); }, icon: Wifi, group: "system", wide: true },
  { id: "services", get title() { return t("nav.services"); }, get description() { return t("nav.servicesHelp"); }, icon: Cpu, group: "system", wide: true },
  { id: "updates", get title() { return t("nav.updates"); }, get description() { return t("nav.updatesHelp"); }, icon: RefreshCw, group: "system", wide: true },
];

export const ACCOUNT_PAGE: PageMeta = { id: "account", get title() { return t("nav.account"); }, get description() { return t("nav.accountHelp"); }, icon: UserRound, group: "system", wide: true };

export function pageMeta(id: PageId): PageMeta {
  return id === "account" ? ACCOUNT_PAGE : PAGES.find((p) => p.id === id)!;
}

export function pageFromHash(): PageId {
  const id = location.hash.replace(/^#\/?/, "");
  return id === "account" || PAGES.some((p) => p.id === id) ? (id as PageId) : "overview";
}

export function navHint(id: PageId, status?: Status, passthrough?: PassthroughState): { text: string; tone?: Tone } | undefined {
  if (id === "output") {
    switch (passthrough?.state) {
      case "running": return { text: t("nav.passthrough"), tone: "good" };
      case "no-signal": return { text: t("nav.waitingSignal"), tone: "warning" };
      case "protected": return { text: t("nav.protected"), tone: "warning" };
    }
    return undefined;
  }
  if (!status) return undefined;
  const hw = status.hardware;
  switch (id) {
    case "apps": {
      const app = status.apps.find((a) => a.id === status.active);
      return app ? { text: app.name, tone: unitTone(app.unit) } : { text: t("nav.notEnabled"), tone: "warning" };
    }
    case "media":
      if (!status.media?.known) return { text: t("common.unknown"), tone: "warning" };
      return status.media.inserted ? { text: status.media.cdrom ? t("nav.disc") : t("nav.disk"), tone: status.media.connected ? "good" : "warning" } : undefined;
    case "video":
      return hw.hdmi.signal ? { text: `${hw.hdmi.height}p`, tone: "good" } : { text: t("nav.noSignal"), tone: "warning" };
    case "cooling":
      return { text: celsius(hw.tempC), tone: tempTone(hw.tempC) };
    case "services": {
      const failed = status.platform.filter((p) => p.unit.active === "failed").length;
      return failed ? { text: t("nav.failed", { count: failed }), tone: "critical" } : undefined;
    }
  }
  return undefined;
}

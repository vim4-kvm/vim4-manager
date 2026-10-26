import {
  Cpu, Disc3, Fan, HardDrive, LayoutDashboard, MonitorPlay, MonitorUp, RefreshCw, Server, UserRound, Video, Wifi,
  type LucideIcon,
} from "lucide-react";
import type { PassthroughState, Status } from "@/api";
import type { Tone } from "@/components/StatusDot";
import { tempTone, unitTone } from "@/lib/units";

export type PageId = "overview" | "apps" | "media" | "disks" | "storage" | "video" | "output" | "cooling" | "network" | "services" | "updates" | "account";

export interface PageMeta {
  id: PageId;
  title: string;
  description?: string;
  icon: LucideIcon;
  group: "控制台" | "设备" | "系统";
  wide?: boolean;
}

export const PAGE_GROUPS = ["控制台", "设备", "系统"] as const;

export const PAGES: PageMeta[] = [
  { id: "overview", title: "概览", description: "设备状态、资源趋势与常用操作。", icon: LayoutDashboard, group: "控制台", wide: true },
  { id: "apps", title: "KVM 界面", description: "四个界面共用采集、编码器和键鼠，同一时间只运行一个。", icon: MonitorPlay, group: "控制台", wide: true },
  { id: "media", title: "虚拟介质", description: "把镜像作为 U 盘或光盘交给被控电脑，四个 KVM 界面共用。", icon: Disc3, group: "控制台", wide: true },
  { id: "disks", title: "数据盘", description: "在板子上创建 U 盘镜像，上传或取回文件，挂载后被控电脑当作普通 U 盘使用。", icon: HardDrive, group: "控制台", wide: true },
  { id: "storage", title: "网络存储", description: "连接 SMB / NFS 共享，用于保存文件或制作虚拟 U 盘。", icon: Server, group: "控制台", wide: true },
  { id: "video", title: "视频输入", description: "管理被控电脑识别到的显示器能力与 HDR 映射。", icon: Video, group: "设备", wide: true },
  { id: "output", title: "HDMI 输出", description: "管理板子 HDMI OUT 口连接的本地显示器。", icon: MonitorUp, group: "设备", wide: true },
  { id: "cooling", title: "散热", description: "查看温度并调整自动风扇曲线。", icon: Fan, group: "设备", wide: true },
  { id: "network", title: "网络", description: "管理有线、Wi-Fi、热点和 Tailscale 连接。", icon: Wifi, group: "系统", wide: true },
  { id: "services", title: "底层服务", description: "查看板级服务状态，按需重启允许维护的服务。", icon: Cpu, group: "系统", wide: true },
  { id: "updates", title: "更新", description: "查看软件版本、组件更新和可切换的内核。", icon: RefreshCw, group: "系统", wide: true },
];

export const ACCOUNT_PAGE: PageMeta = { id: "account", title: "账户", description: "管理管理员凭据与已登录的设备。", icon: UserRound, group: "系统", wide: true };

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
      case "running": return { text: "透传", tone: "good" };
      case "no-signal": return { text: "等待信号", tone: "warning" };
      case "protected": return { text: "受保护", tone: "warning" };
    }
    return undefined;
  }
  if (!status) return undefined;
  const hw = status.hardware;
  switch (id) {
    case "apps": {
      const app = status.apps.find((a) => a.id === status.active);
      return app ? { text: app.name, tone: unitTone(app.unit) } : { text: "未启用", tone: "warning" };
    }
    case "media":
      if (!status.media?.known) return { text: "未知", tone: "warning" };
      return status.media.inserted ? { text: status.media.cdrom ? "光盘" : "磁盘", tone: status.media.connected ? "good" : "warning" } : undefined;
    case "video":
      return hw.hdmi.signal ? { text: `${hw.hdmi.height}p`, tone: "good" } : { text: "无信号", tone: "warning" };
    case "cooling":
      return { text: `${Math.round(hw.tempC)}°`, tone: tempTone(hw.tempC) };
    case "services": {
      const failed = status.platform.filter((p) => p.unit.active === "failed").length;
      return failed ? { text: `${failed} 失败`, tone: "critical" } : undefined;
    }
  }
  return undefined;
}

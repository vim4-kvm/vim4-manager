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
  { id: "media", title: "虚拟介质", description: "挂载到被控电脑的 U 盘或光盘。四个界面共用同一个 USB 存储设备，切换界面不会改变已挂载的介质。", icon: Disc3, group: "控制台" },
  { id: "disks", title: "数据盘", description: "在板子上创建 U 盘镜像，上传或取回文件，挂载后被控电脑当作普通 U 盘使用。", icon: HardDrive, group: "控制台", wide: true },
  { id: "storage", title: "网络存储", description: "把 NAS 的 SMB/NFS 共享连接到板子，用来保存录屏，或把其中的文件夹作为 U 盘交给被控电脑。", icon: Server, group: "控制台", wide: true },
  { id: "video", title: "视频输入", description: "管理显示器能力与 HDR 映射。", icon: Video, group: "设备" },
  { id: "output", title: "HDMI 输出", description: "板子 HDMI OUT 口接的本地显示器。", icon: MonitorUp, group: "设备" },
  { id: "cooling", title: "散热", description: "查看温度，调整自动风扇曲线。", icon: Fan, group: "设备" },
  { id: "network", title: "网络", description: "管理无线连接、热点与 Tailscale 组网。", icon: Wifi, group: "系统", wide: true },
  { id: "services", title: "底层服务", description: "重启 HDMI 采集会先暂停当前界面，完成后自动恢复。", icon: Cpu, group: "系统" },
  { id: "updates", title: "更新", description: "查看组件版本、软件更新和已安装的内核。", icon: RefreshCw, group: "系统" },
];

export const ACCOUNT_PAGE: PageMeta = { id: "account", title: "账户", description: "管理员账户用于登录管理面板。", icon: UserRound, group: "系统" };

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

import type { Unit } from "@/api";
import type { Tone } from "@/components/StatusDot";

export function unitTone(unit: Unit): Tone {
  if (!unit.loaded) return "idle";
  if (unit.active === "active") return "good";
  if (unit.active === "failed") return "critical";
  if (unit.active === "activating" || unit.active === "deactivating" || unit.active === "reloading") return "warning";
  return "idle";
}

export function unitLabel(unit: Unit): string {
  if (!unit.loaded) return "未安装";
  switch (unit.active) {
    case "active":
      // Oneshot board units stay "active (exited)" after doing their work.
      return unit.sub === "exited" ? "已完成" : "运行中";
    case "failed":
      return "失败";
    case "activating":
      return "启动中";
    case "deactivating":
      return "停止中";
    default:
      return "已停止";
  }
}

export function duration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分钟`;
}

export function since(unit: Unit, now: number): string | undefined {
  if (!unit.since || unit.active !== "active") return undefined;
  return duration(Math.max(0, (now - Date.parse(unit.since)) / 1000));
}

export function tempTone(c: number): Tone {
  return c >= 85 ? "critical" : c >= 70 ? "warning" : "good";
}

export function kvmURL(port: number, app: string): string {
  return `${location.protocol}//${location.hostname}:${port}/?kvm=${encodeURIComponent(app)}`;
}

export const celsius = (v: number) => `${v.toFixed(1)} °C`;

export function clockTime(t: number, now: number): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

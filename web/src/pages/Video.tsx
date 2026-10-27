import { previewHDRCurve, setHDRCurve, setHDRMapping } from "@/api";
import { EDIDPanel } from "@/EDIDPanel";
import { HDRPanel } from "@/HDRPanel";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingsCard } from "@/components/SettingsCard";
import { PageHeading } from "@/components/PageHeading";
import { StatusLabel } from "@/components/StatusDot";
import { SettingRow } from "@/components/SettingRow";
import { Switch } from "@/components/ui/switch";
import { useActionStore } from "@/stores/action";
import { useStatusStore } from "@/stores/status";

export function Video() {
  const hw = useStatusStore((s) => s.status?.hardware);
  const stale = useStatusStore((s) => s.stale);
  const busy = useActionStore((s) => !!s.busy);
  const run = useActionStore((s) => s.run);
  const mapping = hw?.hdrToSdr ?? true;
  return <>
    <PageHeading page="video" />
    {hw && <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border bg-card px-5 py-5 text-sm">
      <StatusLabel tone={stale ? "warning" : hw.hdmi.signal ? "good" : "idle"}><strong>{stale ? "连接中断" : hw.hdmi.signal ? "输入已连接" : "输入无信号"}</strong></StatusLabel>
      {hw.hdmi.signal && <>
        <span className="font-semibold tabular-nums">{hw.hdmi.width} × {hw.hdmi.height}</span>
        <span className="text-muted-foreground tabular-nums">{hw.hdmi.refreshHz ? `${Number(hw.hdmi.refreshHz.toFixed(2))} Hz` : "刷新率未知"}</span>
        <span className="text-muted-foreground">{hw.hdmi.colorSpace || "色彩格式未知"}{hw.hdmi.depth ? ` · ${hw.hdmi.depth} bit` : ""}</span>
        <span className="text-muted-foreground">{hw.hdmi.hdr || "HDR 状态未知"}</span>
        <span className="text-muted-foreground">{hw.hdmi.audio ? "音频已检测" : "无音频"}</span>
      </>}
    </div>}
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
    <SettingsCard title="显示器能力 · EDID" description="被控电脑根据 EDID 选择分辨率和 HDR 模式。"><EDIDPanel /></SettingsCard>
    <SettingsCard title="HDR 转 SDR" description="远程画面的全局默认设置。UU 连接期间可临时切换 HDR，断开后恢复此设置。HDMI 输出单独设置。">
      {hw && <SettingRow title="启用 HDR 转 SDR"
        description="关闭后，四套 KVM 的 H.265 可保留 HDR10，需客户端支持 HDR；H.264、JPEG 和截图仍为 SDR。"
        status={!mapping && !hw.hdrRemoteAvailable ? "当前运行环境继续使用 SDR" : !hw.hdmi.signal ? "等待输入信号" : hw.hdmi.hdr === "SDR" ? "输入为 SDR" : mapping ? "默认转换为 SDR" : "默认保留 HDR10"}
        inactive={!hw.hdmi.signal || hw.hdmi.hdr === "SDR"}
        control={<Switch aria-label="启用 HDR 转 SDR" checked={mapping} disabled={busy || stale}
          onCheckedChange={(enabled) => void run("正在保存 HDR 设置…", () => setHDRMapping(enabled), enabled ? "HDR 转 SDR 已开启" : "HDR 转 SDR 默认设置已关闭")} />} />}
      {hw ? <HDRPanel curve={hw.hdrCurve} hdr={hw.hdmi.hdr} mappingEnabled={mapping} busy={busy || !mapping} onPreview={previewHDRCurve}
        onSave={(curve) => void run("正在保存 HDR 映射…", () => setHDRCurve(curve), `HDR 映射已保存：SDR 白 ${curve.white} 尼特，高光保留到 ${curve.peak} 尼特`)} />
        : <PanelSkeleton />}
    </SettingsCard>
    </div>
  </>;
}

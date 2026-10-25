import { previewHDRCurve, setHDRCurve } from "@/api";
import { EDIDPanel } from "@/EDIDPanel";
import { HDRPanel } from "@/HDRPanel";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingsCard } from "@/components/SettingsCard";
import { useActionStore } from "@/stores/action";
import { useStatusStore } from "@/stores/status";

export function Video() {
  const hw = useStatusStore((s) => s.status?.hardware);
  const busy = useActionStore((s) => !!s.busy);
  const run = useActionStore((s) => s.run);
  return <>
    <SettingsCard title="EDID" description="被控电脑看到的显示器型号与能力。"><EDIDPanel /></SettingsCard>
    <SettingsCard title="HDR 转 SDR" description="被控机输出 HDR 时按此曲线映射为 SDR。画面偏暗就提高桌面亮度，高光发白就扩大高光范围。">
      {hw ? <HDRPanel curve={hw.hdrCurve} hdr={hw.hdmi.hdr} busy={busy} onPreview={previewHDRCurve}
        onSave={(curve) => void run("正在保存 HDR 映射…", () => setHDRCurve(curve), `HDR 映射已保存：SDR 白 ${curve.white} 尼特，高光保留到 ${curve.peak} 尼特`)} />
        : <PanelSkeleton />}
    </SettingsCard>
  </>;
}

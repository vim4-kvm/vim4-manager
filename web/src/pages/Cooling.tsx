import { setFanCurve } from "@/api";
import { FanPanel } from "@/FanPanel";
import { Fact } from "@/components/FactGrid";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingsCard } from "@/components/SettingsCard";
import { PageHeading } from "@/components/PageHeading";
import { StatusLabel } from "@/components/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Fan, Thermometer } from "lucide-react";
import { celsius, tempTone } from "@/lib/units";
import { useActionStore } from "@/stores/action";
import { useStatusStore } from "@/stores/status";

export function Cooling() {
  const hw = useStatusStore((s) => s.status?.hardware);
  const busy = useActionStore((s) => !!s.busy);
  const run = useActionStore((s) => s.run);
  if (!hw) return <><PageHeading page="cooling" /><SettingsCard><PanelSkeleton /></SettingsCard></>;
  return <>
    <PageHeading page="cooling" />
    <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <Fact card label="SoC 温度" value={celsius(hw.tempC)} icon={Thermometer} tone={tempTone(hw.tempC)} />
      {hw.zones.filter((z) => !/soc/i.test(z.name)).map((z) => <Fact card key={z.name} label={`${z.name.toUpperCase()} 温度`} value={celsius(z.tempC)} icon={Thermometer} tone={tempTone(z.tempC)} />)}
      <Fact card label="风扇占空比" value={`${hw.fanPercent}%`} icon={Fan} detail={hw.fanAuto ? "自动调速" : "手动模式"} />
    </dl>
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_260px]">
    {hw.fanTriggers ? <SettingsCard title="风扇曲线" description="拖动曲线上的三个温度点，或选一个预设。应用后立即生效，重启后保留。">
      <FanPanel saved={hw.fanTriggers} auto={hw.fanAuto} tempC={hw.tempC} percent={hw.fanPercent} busy={busy}
        onApply={async (t) => { await run("正在应用风扇曲线…", () => setFanCurve(t), `风扇曲线已应用：${t.low} / ${t.mid} / ${t.high} °C`); }} />
    </SettingsCard> : <p className="text-sm text-muted-foreground">未检测到 MCU 风扇控制接口。</p>}
    <SettingsCard title="当前策略">
      <dl className="space-y-4 text-sm">
        <div className="flex items-center justify-between gap-3"><dt className="text-muted-foreground">模式</dt><dd><Badge variant="secondary">{hw.fanAuto ? "自动" : "手动"}</Badge></dd></div>
        <div className="flex items-center justify-between gap-3 border-t pt-4"><dt className="text-muted-foreground">当前温度</dt><dd className="font-semibold tabular-nums">{celsius(hw.tempC)}</dd></div>
        <div className="flex items-center justify-between gap-3 border-t pt-4"><dt className="text-muted-foreground">占空比</dt><dd className="font-semibold tabular-nums">{hw.fanPercent}%</dd></div>
        <div className="border-t pt-4"><StatusLabel tone={tempTone(hw.tempC)}>{hw.tempC >= 85 ? "温度较高" : hw.tempC >= 70 ? "注意温度" : "温度正常"}</StatusLabel></div>
      </dl>
      <p className="text-xs text-muted-foreground">驱动每 30 秒调整一次，每次最多变化 5%。应用曲线后，实际转速会逐步跟随。</p>
    </SettingsCard>
    </div>
  </>;
}

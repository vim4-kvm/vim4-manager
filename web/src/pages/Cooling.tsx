import { setFanCurve } from "@/api";
import { FanPanel } from "@/FanPanel";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingsCard } from "@/components/SettingsCard";
import { PageHeading } from "@/components/PageHeading";
import { StatusLabel } from "@/components/StatusDot";
import { celsius, tempTone } from "@/lib/units";
import { useActionStore } from "@/stores/action";
import { useStatusStore } from "@/stores/status";

export function Cooling() {
  const hw = useStatusStore((s) => s.status?.hardware);
  const busy = useActionStore((s) => !!s.busy);
  const run = useActionStore((s) => s.run);
  if (!hw) return <><PageHeading page="cooling" /><SettingsCard><PanelSkeleton /></SettingsCard></>;
  const zones = hw.zones.filter((z) => !/soc/i.test(z.name));
  return <>
    <PageHeading page="cooling" />
    <section aria-label="当前温度" className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border bg-card px-5 py-4 text-sm">
      <StatusLabel tone={tempTone(hw.tempC)}><strong>{hw.tempC >= 85 ? "温度较高" : hw.tempC >= 70 ? "注意温度" : "温度正常"}</strong></StatusLabel>
      <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <div className="flex items-baseline gap-2"><dt className="text-muted-foreground">SoC</dt><dd className="text-base font-semibold tabular-nums">{celsius(hw.tempC)}</dd></div>
        {zones.map((z) => <div key={z.name} className="flex items-baseline gap-2"><dt className="text-muted-foreground">{z.name.toUpperCase()}</dt><dd className="tabular-nums">{celsius(z.tempC)}</dd></div>)}
        <div className="flex items-baseline gap-2"><dt className="text-muted-foreground">风扇</dt><dd className="tabular-nums">{hw.fanPercent > 0 ? `${hw.fanPercent}%` : "停转"}<span className="ml-1.5 text-muted-foreground">{hw.fanAuto ? "自动调速" : "手动模式"} · 占空比</span></dd></div>
      </dl>
    </section>
    {hw.fanTriggers ? <SettingsCard title="风扇曲线" description="拖动曲线上的三个温度点，或选一个预设。应用后立即生效，重启后保留。">
      <FanPanel saved={hw.fanTriggers} auto={hw.fanAuto} tempC={hw.tempC} percent={hw.fanPercent} busy={busy}
        onApply={async (t) => { await run("正在应用风扇曲线…", () => setFanCurve(t), `风扇曲线已应用：${t.low} / ${t.mid} / ${t.high} °C`); }} />
    </SettingsCard> : <p className="text-sm text-muted-foreground">未检测到 MCU 风扇控制接口。</p>}
  </>;
}

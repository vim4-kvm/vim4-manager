import { setFanCurve } from "@/api";
import { FanPanel } from "@/FanPanel";
import { Fact, FactGrid } from "@/components/FactGrid";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingsCard } from "@/components/SettingsCard";
import { celsius, tempTone } from "@/lib/units";
import { useActionStore } from "@/stores/action";
import { useStatusStore } from "@/stores/status";

export function Cooling() {
  const hw = useStatusStore((s) => s.status?.hardware);
  const busy = useActionStore((s) => !!s.busy);
  const run = useActionStore((s) => s.run);
  if (!hw) return <SettingsCard><PanelSkeleton /></SettingsCard>;
  return <>
    {hw.fanTriggers ? <SettingsCard title="风扇曲线" description="拖动曲线上的三个温度点，或选一个预设。应用后立即生效，重启后保留。">
      <FanPanel saved={hw.fanTriggers} auto={hw.fanAuto} tempC={hw.tempC} percent={hw.fanPercent} busy={busy}
        onApply={async (t) => { await run("正在应用风扇曲线…", () => setFanCurve(t), `风扇曲线已应用：${t.low} / ${t.mid} / ${t.high} °C`); }} />
    </SettingsCard> : <p className="text-sm text-muted-foreground">未检测到 MCU 风扇控制接口。</p>}
    <SettingsCard title="各区温度"><FactGrid>{hw.zones.map((z) => <Fact key={z.name} label={z.name.toUpperCase()} value={celsius(z.tempC)} tone={tempTone(z.tempC)} />)}</FactGrid></SettingsCard>
  </>;
}

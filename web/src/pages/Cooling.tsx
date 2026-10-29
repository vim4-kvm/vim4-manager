import { setFanCurve } from "@/api";
import { FanPanel } from "@/FanPanel";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingsCard } from "@/components/SettingsCard";
import { PageHeading } from "@/components/PageHeading";
import { StatusLabel } from "@/components/StatusDot";
import { celsius, tempTone } from "@/lib/units";
import { useActionStore } from "@/stores/action";
import { useStatusStore } from "@/stores/status";
import { useT } from "@/i18n";
import { number } from "@/i18n/format";

export function Cooling() {
  const t = useT();
  const hw = useStatusStore((s) => s.status?.hardware);
  const busy = useActionStore((s) => !!s.busy);
  const run = useActionStore((s) => s.run);
  if (!hw) return <><PageHeading page="cooling" /><SettingsCard><PanelSkeleton /></SettingsCard></>;
  const zones = hw.zones.filter((z) => !/soc/i.test(z.name));
  return <>
    <PageHeading page="cooling" />
    <section aria-label={t("cooling.temperatures")} className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border bg-card px-5 py-4 text-sm">
      <StatusLabel tone={tempTone(hw.tempC)}><strong>{hw.tempC >= 85 ? t("cooling.hot") : hw.tempC >= 70 ? t("cooling.warm") : t("cooling.normal")}</strong></StatusLabel>
      <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <div className="flex items-baseline gap-2"><dt className="text-muted-foreground">SoC</dt><dd className="text-base font-semibold tabular-nums">{celsius(hw.tempC)}</dd></div>
        {zones.map((z) => <div key={z.name} className="flex items-baseline gap-2"><dt className="text-muted-foreground">{z.name.toUpperCase()}</dt><dd className="tabular-nums">{celsius(z.tempC)}</dd></div>)}
        <div className="flex items-baseline gap-2"><dt className="text-muted-foreground">{t("cooling.fan")}</dt><dd className="tabular-nums">{hw.fanPercent > 0 ? `${number(hw.fanPercent)}%` : t("cooling.stopped")}<span className="ml-1.5 text-muted-foreground">{hw.fanAuto ? t("cooling.autoDuty") : t("cooling.manualDuty")}</span></dd></div>
      </dl>
    </section>
    {hw.fanTriggers ? <SettingsCard title={t("cooling.curve")} description={t("cooling.help")}>
      <FanPanel saved={hw.fanTriggers} auto={hw.fanAuto} tempC={hw.tempC} percent={hw.fanPercent} busy={busy}
        onApply={async (curve) => { await run(t("cooling.applying"), () => setFanCurve(curve), t("cooling.applied", { low: number(curve.low), mid: number(curve.mid), high: number(curve.high) })); }} />
    </SettingsCard> : <p className="text-sm text-muted-foreground">{t("cooling.unavailable")}</p>}
  </>;
}

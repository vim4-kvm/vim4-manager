import { useT } from "@/i18n";
import { useState } from "react";
import { RefreshCw, RotateCw } from "lucide-react";
import { restartUnit, type Platform } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingsCard } from "@/components/SettingsCard";
import { PageHeading } from "@/components/PageHeading";
import { Notice } from "@/components/Notice";
import { Fact, FactGrid } from "@/components/FactGrid";
import { StatusLabel } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { since, unitLabel, unitTone } from "@/lib/units";
import { useActionStore } from "@/stores/action";
import { useStatusStore } from "@/stores/status";

export function Services() {
  const t = useT();
  const status = useStatusStore((s) => s.status);
  const now = useStatusStore((s) => s.now);
  const stale = useStatusStore((s) => s.stale);
  const refresh = useStatusStore((s) => s.refresh);
  const busy = useActionStore((s) => !!s.busy);
  const run = useActionStore((s) => s.run);
  const [restarting, setRestarting] = useState<Platform>();
  const [refreshing, setRefreshing] = useState(false);
  const platform = status?.platform ?? [];
  const running = platform.filter((p) => p.unit.active === "active" && p.unit.sub !== "exited").length;
  const completed = platform.filter((p) => p.unit.active === "active" && p.unit.sub === "exited").length;
  const failed = platform.filter((p) => p.unit.active === "failed").length;
  const healthy = !!platform.length && running + completed === platform.length;
  return <>
    <PageHeading page="services" />
    {status && <SettingsCard><div className="flex flex-wrap items-center gap-6">
      <div className="min-w-0 flex-1 basis-60 space-y-1"><StatusLabel tone={stale ? "warning" : failed ? "critical" : healthy ? "good" : "warning"}><strong className="text-base">{stale ? t("services.stale") : failed ? t("services.unhealthy") : healthy ? t("services.healthy") : t("services.inactive")}</strong></StatusLabel><p className="ml-4 text-xs text-muted-foreground">{t("services.autoRefresh")}</p></div>
      <FactGrid className="flex-1 basis-60" cols={3}><Fact label={t("units.running")} value={String(running)} /><Fact label={t("units.completed")} value={String(completed)} /><Fact label={t("services.failed")} value={String(failed)} tone={failed ? "critical" : undefined} /></FactGrid>
      <Button variant="outline" size="icon" aria-label={t("services.refresh")} disabled={refreshing} onClick={async () => { setRefreshing(true); await refresh(); setRefreshing(false); }}><RefreshCw className={refreshing ? "motion-safe:animate-spin" : undefined} /></Button>
    </div></SettingsCard>}
    <SettingsCard title={t("services.statusTitle")} flush>
    {status ? <div className="min-w-0 overflow-auto"><table className="w-full text-left text-sm [&_th]:bg-muted/50 [&_th]:px-5 [&_th]:py-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground [&_td]:border-t [&_td]:px-5 [&_td]:py-4 [&_td]:align-middle">
      <thead><tr><th>{t("services.service")}</th><th>{t("services.status")}</th><th className="hidden md:table-cell">{t("services.uptime")}</th><th className="hidden md:table-cell" aria-label={t("common.actions")} /></tr></thead>
      <tbody>{status.platform.map((p) => {
        const action = p.restartable ? <Button variant="outline" disabled={busy || stale || !p.unit.loaded} onClick={() => setRestarting(p)}><RotateCw />{t("common.restart")}</Button>
          : <span className="text-xs text-muted-foreground">{t("services.managed")}</span>;
        return <tr key={p.unit.name}>
        <td><span className="block font-medium">{p.name}</span><span className="block break-all font-mono text-xs text-muted-foreground">{p.unit.name}</span><div className="mt-3 md:hidden">{action}</div></td>
        <td><StatusLabel tone={unitTone(p.unit)}>{unitLabel(p.unit)}</StatusLabel></td>
        <td className="hidden tabular-nums text-muted-foreground md:table-cell">{p.unit.sub === "exited" ? "—" : since(p.unit, now) ?? "—"}</td>
        <td className="hidden text-right md:table-cell">{action}</td>
      </tr>;
      })}</tbody>
    </table></div> : <div className="p-5"><PanelSkeleton /></div>}
    <div className="p-4"><Notice warning>{t("services.hdmiRestartHelp")}</Notice></div>
    {restarting && <ConfirmDialog open title={t("services.restartTitle", { name: restarting.name })} confirm={t("common.restart")} disabled={busy || !restarting.unit.loaded}
      description={t("services.restartHelp")}
      onOpenChange={(open) => { if (!open) setRestarting(undefined); }} onConfirm={() => {
        void run(t("services.restarting", { name: restarting.name }), () => restartUnit(restarting.unit.name), t("services.restarted", { name: restarting.name }));
        setRestarting(undefined);
      }} />}
  </SettingsCard>
  </>;
}

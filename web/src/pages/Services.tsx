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
      <div className="min-w-0 flex-1 basis-60 space-y-1"><StatusLabel tone={stale ? "warning" : failed ? "critical" : healthy ? "good" : "warning"}><strong className="text-base">{stale ? "连接中断，显示上次状态" : failed ? "有服务运行异常" : healthy ? "所有已列出服务正常" : "部分服务未运行"}</strong></StatusLabel><p className="ml-4 text-xs text-muted-foreground">状态自动刷新</p></div>
      <FactGrid className="flex-1 basis-60" cols={3}><Fact label="运行中" value={String(running)} /><Fact label="已完成" value={String(completed)} /><Fact label="异常" value={String(failed)} tone={failed ? "critical" : undefined} /></FactGrid>
      <Button variant="outline" size="icon" aria-label="刷新服务状态" disabled={refreshing} onClick={async () => { setRefreshing(true); await refresh(); setRefreshing(false); }}><RefreshCw className={refreshing ? "motion-safe:animate-spin" : undefined} /></Button>
    </div></SettingsCard>}
    <SettingsCard title="服务状态" flush>
    {status ? <div className="min-w-0 overflow-auto"><table className="w-full text-left text-sm [&_th]:bg-muted/50 [&_th]:px-5 [&_th]:py-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground [&_td]:border-t [&_td]:px-5 [&_td]:py-4 [&_td]:align-middle">
      <thead><tr><th>服务</th><th>状态</th><th className="hidden md:table-cell">已运行</th><th aria-label="操作" /></tr></thead>
      <tbody>{status.platform.map((p) => <tr key={p.unit.name}>
        <td><span className="block font-medium">{p.name}</span><span className="block break-all font-mono text-xs text-muted-foreground">{p.unit.name}</span></td>
        <td><StatusLabel tone={unitTone(p.unit)}>{unitLabel(p.unit)}</StatusLabel></td>
        <td className="hidden tabular-nums text-muted-foreground md:table-cell">{p.unit.sub === "exited" ? "—" : since(p.unit, now) ?? "—"}</td>
        <td className="text-right">{p.restartable ? <Button variant="outline" disabled={busy || stale || !p.unit.loaded} onClick={() => setRestarting(p)}><RotateCw />重启</Button> : <span className="whitespace-nowrap text-xs text-muted-foreground">由系统管理</span>}</td>
      </tr>)}</tbody>
    </table></div> : <div className="p-5"><PanelSkeleton /></div>}
    <div className="p-4"><Notice warning>重启 HDMI 采集会先暂停当前 KVM 界面，完成后自动恢复。</Notice></div>
    {restarting && <ConfirmDialog open title={`重启${restarting.name}`} confirm="重启" disabled={busy || !restarting.unit.loaded}
      description="会先暂停当前 KVM 界面，完成后自动恢复。"
      onOpenChange={(open) => { if (!open) setRestarting(undefined); }} onConfirm={() => {
        void run(`正在重启${restarting.name}…`, () => restartUnit(restarting.unit.name), `${restarting.name}已重启`);
        setRestarting(undefined);
      }} />}
  </SettingsCard>
  </>;
}

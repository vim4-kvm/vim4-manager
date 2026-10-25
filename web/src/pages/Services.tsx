import { useState } from "react";
import { restartUnit, type Platform } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingsCard } from "@/components/SettingsCard";
import { StatusLabel } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { since, unitLabel, unitTone } from "@/lib/units";
import { useActionStore } from "@/stores/action";
import { useStatusStore } from "@/stores/status";

export function Services() {
  const status = useStatusStore((s) => s.status);
  const now = useStatusStore((s) => s.now);
  const busy = useActionStore((s) => !!s.busy);
  const run = useActionStore((s) => s.run);
  const [restarting, setRestarting] = useState<Platform>();
  return <SettingsCard label="底层服务">
    {status ? <div className="min-w-0 overflow-auto"><table className="w-full text-left text-sm [&_th]:pb-3 [&_th]:font-medium [&_th]:text-muted-foreground [&_td]:border-t [&_td]:py-3 [&_td]:pr-3">
      <thead><tr><th>服务</th><th>状态</th><th className="hidden md:table-cell">已运行</th><th aria-label="操作" /></tr></thead>
      <tbody>{status.platform.map((p) => <tr key={p.unit.name}>
        <td><span className="block font-medium">{p.name}</span><span className="block break-all font-mono text-xs text-muted-foreground">{p.unit.name}</span></td>
        <td><StatusLabel tone={unitTone(p.unit)}>{unitLabel(p.unit)}</StatusLabel></td>
        <td className="hidden tabular-nums text-muted-foreground md:table-cell">{since(p.unit, now) ?? "—"}</td>
        <td className="text-right">{p.restartable && <Button size="sm" variant="outline" disabled={busy || !p.unit.loaded} onClick={() => setRestarting(p)}>重启</Button>}</td>
      </tr>)}</tbody>
    </table></div> : <PanelSkeleton />}
    {restarting && <ConfirmDialog open title={`重启${restarting.name}`} confirm="重启" disabled={busy || !restarting.unit.loaded}
      onOpenChange={(open) => { if (!open) setRestarting(undefined); }} onConfirm={() => {
        void run(`正在重启${restarting.name}…`, () => restartUnit(restarting.unit.name), `${restarting.name}已重启`);
        setRestarting(undefined);
      }} />}
  </SettingsCard>;
}

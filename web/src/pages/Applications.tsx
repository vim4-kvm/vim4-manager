import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { restartUnit, selectApp, type App } from "@/api";
import { MediaSummary, MediaWait, needsMediaEject } from "@/MediaPanel";
import { AnimatedList } from "@/components/AnimatedList";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingRow } from "@/components/SettingRow";
import { SettingsCard } from "@/components/SettingsCard";
import { StatusLabel } from "@/components/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { kvmURL, since, unitLabel, unitTone } from "@/lib/units";
import { report, useActionStore } from "@/stores/action";
import { useStatusStore } from "@/stores/status";

export function Applications() {
  const { status, stale, now } = useStatusStore(useShallow((s) => ({ status: s.status, stale: s.stale, now: s.now })));
  const busy = useActionStore((s) => !!s.busy);
  const run = useActionStore((s) => s.run);
  const [confirming, setConfirming] = useState<App>();
  const [restarting, setRestarting] = useState<App>();
  const [waiting, setWaiting] = useState<{ app: App; source: string; started: number }>();
  const waitingRef = useRef(false);

  const cancelWaiting = () => {
    waitingRef.current = false;
    setWaiting(undefined);
  };
  const switchApp = (app: App) => {
    cancelWaiting();
    return run(`正在切换到 ${app.name}…`, () => selectApp(app.id), `已切换到 ${app.name}`);
  };
  useEffect(() => {
    // Cancel at navigation time even while the outgoing page finishes its fade.
    const leave = () => {
      if (location.hash === "#/apps" || !waitingRef.current) return;
      cancelWaiting();
      report("warning", "已取消等待切换，请确认当前状态后重新选择。");
    };
    window.addEventListener("hashchange", leave);
    return () => { window.removeEventListener("hashchange", leave); waitingRef.current = false; };
  }, []);
  useEffect(() => {
    if (!waiting || !waitingRef.current) return;
    if (stale || !status?.media?.known || status.active !== waiting.source || Date.now() - waiting.started >= 300_000) {
      cancelWaiting();
      report("warning", "已取消等待切换，请确认当前状态后重新选择。");
      return;
    }
    // Clear the ref before submitting: repeated polls must not switch twice.
    if (!status.media.inserted) void switchApp(waiting.app);
  }, [waiting, status, stale]);

  if (!status) return <SettingsCard><PanelSkeleton /></SettingsCard>;
  const locked = busy || !!waiting || stale || !status.media?.known;
  const mediaBlocked = !!confirming && needsMediaEject(status.media, confirming.id);
  return <>
    {waiting ? <MediaWait media={status.media} target={waiting.app.name} onCancel={cancelWaiting} />
      : <MediaSummary media={stale ? undefined : status.media} />}
    <AnimatedList items={status.apps} getKey={(app) => app.id} className="flex flex-col gap-4">{(app) => {
      const selected = app.id === status.active;
      const running = app.unit.active === "active";
      return <SettingsCard className={selected ? "ring-primary/40" : undefined}>
        <SettingRow title={app.name} badges={selected && <Badge variant="secondary">开机启用</Badge>}
          description={<>
            <span className="block">{app.description}</span>
            <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              <StatusLabel tone={unitTone(app.unit)}>{unitLabel(app.unit)}</StatusLabel>
              <span className="tabular-nums">{since(app.unit, now) ?? ""}</span>
            </span>
          </>}
          control={<>
            {!app.unit.loaded ? <span className="text-muted-foreground">未安装</span> : selected ? <>
              <Button variant="outline" disabled={locked} onClick={() => setRestarting(app)}>重启</Button>
              <Button asChild className={running ? undefined : "pointer-events-none opacity-50"}>
                <a href={kvmURL(app.port, app.id)} aria-disabled={!running}>打开</a>
              </Button>
            </> : <Button variant="outline" disabled={locked || confirming?.id === app.id} onClick={() => setConfirming(app)}>切换到此</Button>}
          </>} />
      </SettingsCard>;
    }}</AnimatedList>
    {!status.apps.some((a) => a.id === status.active) && <p className="text-sm text-muted-foreground">尚未启用任何界面，选择一个即可开机自动启动。</p>}
    {confirming && <ConfirmDialog open title={`切换到 ${confirming.name}`} disabled={locked}
      description={mediaBlocked ? "虚拟磁盘仍已挂载。先在被控电脑安全弹出，检测到弹出后再切换。" : "当前远程会话会断开。"}
      confirm={mediaBlocked ? "弹出后继续切换" : `切换到 ${confirming.name}`}
      onOpenChange={(open) => { if (!open) setConfirming(undefined); }} onConfirm={() => {
        if (mediaBlocked) {
          waitingRef.current = true;
          setWaiting({ app: confirming, source: status.active, started: Date.now() });
          toast.dismiss();
        } else void switchApp(confirming);
        setConfirming(undefined);
      }} />}
    {restarting && <ConfirmDialog open title={`重启 ${restarting.name}`} description="当前远程会话会断开。" confirm="重启" disabled={locked}
      onOpenChange={(open) => { if (!open) setRestarting(undefined); }} onConfirm={() => {
        void run(`正在重启 ${restarting.name}…`, () => restartUnit(restarting.unit.name), `${restarting.name} 已重启`);
        setRestarting(undefined);
      }} />}
  </>;
}

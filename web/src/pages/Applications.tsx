import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { ArrowRightLeft, Box, CircuitBoard, ExternalLink, Monitor, Mouse, Network, RotateCw, Usb, Video } from "lucide-react";
import { restartUnit, selectApp, type App } from "@/api";
import { mediaName, MediaSummary, MediaWait, needsMediaEject } from "@/MediaPanel";
import { AnimatedList } from "@/components/AnimatedList";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { PageHeading } from "@/components/PageHeading";
import { Notice } from "@/components/Notice";
import { Fact, FactGrid } from "@/components/FactGrid";
import { DevelopmentBadge } from "@/components/DevelopmentBadge";
import { SettingsCard } from "@/components/SettingsCard";
import { StatusLabel } from "@/components/StatusDot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { kvmURL, since, unitLabel, unitTone } from "@/lib/units";
import { report, useActionStore } from "@/stores/action";
import { useStatusStore } from "@/stores/status";

const appIcons = { onekvm: Monitor, nanokvm: Box, jetkvm: Mouse, pikvm: CircuitBoard };
const appPackages: Record<string, string> = { onekvm: "vim4-onekvm", nanokvm: "vim4-nanokvm", jetkvm: "vim4-jetkvm", pikvm: "vim4-pikvm" };

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

  if (!status) return <><PageHeading page="apps" /><SettingsCard><PanelSkeleton /></SettingsCard></>;
  const locked = busy || !!waiting || stale || !status.media?.known;
  const mediaBlocked = !!confirming && needsMediaEject(status.media, confirming.id);
  const activeApp = status.apps.find((app) => app.id === status.active);
  const apps = [...status.apps].sort((a, b) => Number(b.id === status.active) - Number(a.id === status.active));
  return <>
    <PageHeading page="apps" />
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border bg-success/5 px-5 py-4 text-sm">
      <StatusLabel tone={stale ? "warning" : activeApp ? unitTone(activeApp.unit) : "idle"}>
        <strong>{stale ? "连接中断" : activeApp ? `当前${activeApp.unit.active === "active" ? "运行" : "启用"} ${activeApp.name}` : "尚未启用 KVM"}</strong>
      </StatusLabel>
      {activeApp && <span className="text-muted-foreground">已运行 <span className="text-foreground tabular-nums">{since(activeApp.unit, now) ?? "—"}</span></span>}
      <span className="min-w-0 break-all text-muted-foreground">虚拟介质：{stale || !status.media?.known ? "状态未知" : status.media.inserted ? mediaName(status.media) : "未挂载"}</span>
      <a className="ml-auto inline-flex items-center gap-1 text-link hover:underline" href="#/media">管理虚拟介质 <ExternalLink className="size-3.5" /></a>
    </div>
    {waiting ? <MediaWait media={status.media} target={waiting.app.name} onCancel={cancelWaiting} />
      : <MediaSummary media={stale ? undefined : status.media} />}
    <AnimatedList items={apps} getKey={(app) => app.id} className="grid grid-cols-1 gap-4 lg:grid-cols-2" itemClassName="min-w-0 [&>div]:h-full">{(app) => {
      const selected = app.id === status.active;
      const running = app.unit.active === "active";
      const Icon = appIcons[app.id as keyof typeof appIcons] ?? Monitor;
      const version = status.system.packages.find((pkg) => pkg.name === appPackages[app.id])?.version;
      return <SettingsCard label={app.name} className={selected ? "border-chart-1/60 bg-chart-1/3" : undefined}>
        <div className="flex h-full flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            {selected && <Badge className="border-chart-1/20 bg-chart-1/10 text-chart-1" variant="outline">开机启用</Badge>}
            <Badge variant="secondary"><StatusLabel tone={unitTone(app.unit)}>{unitLabel(app.unit)}</StatusLabel></Badge>
          </div>
          <div className="flex items-center gap-4">
            <div className={`flex size-14 shrink-0 items-center justify-center rounded-xl ${selected ? "bg-chart-1/10 text-chart-1" : "bg-muted text-muted-foreground"}`}><Icon className="size-7" aria-hidden="true" /></div>
            <div className="min-w-0"><h2 className="text-xl font-semibold tracking-tight">{app.name}</h2><p className="mt-1 text-sm text-muted-foreground">{app.description}</p></div>
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 border-t pt-4 text-xs">
            <dt className="text-muted-foreground">服务</dt><dd className="break-all font-mono">{app.unit.name}</dd>
            <dt className="text-muted-foreground">版本</dt><dd className="flex flex-wrap gap-2 break-all font-mono">{version || (app.unit.loaded ? "版本未知" : "未安装")}<DevelopmentBadge version={version ?? ""} /></dd>
          </dl>
          <div className="mt-auto flex flex-wrap gap-3 [&>button]:min-w-24 [&>a]:min-w-24 [&>*]:flex-1">
            {!app.unit.loaded ? <span className="text-muted-foreground">未安装</span> : selected ? <>
              <Button variant="outline" disabled={locked} onClick={() => setRestarting(app)}><RotateCw />重启</Button>
              <Button asChild className={running ? undefined : "pointer-events-none opacity-50"}>
                <a href={kvmURL(app.port, app.id)} aria-disabled={!running}>打开 {app.name}<ExternalLink /></a>
              </Button>
            </> : <Button variant="outline" disabled={locked || confirming?.id === app.id} onClick={() => setConfirming(app)}><ArrowRightLeft />切换到此</Button>}
          </div>
        </div>
      </SettingsCard>;
    }}</AnimatedList>
    <Notice>切换界面会断开当前远程会话。已挂载的介质保持原状；需要弹出时会先提示。</Notice>
    <SettingsCard title="共用设备"><FactGrid>
      <Fact label="HDMI 采集" icon={Video} value={status.hardware.hdmi.signal ? "已连接" : "无信号"} tone={status.hardware.hdmi.signal ? "good" : "warning"} />
      <Fact label="USB 键鼠" icon={Usb} value={status.hardware.usb === "configured" ? "已连接" : status.hardware.usb || "未知"} tone={status.hardware.usb === "configured" ? "good" : "idle"} />
      <Fact label="KVM 网关" icon={Network} value={activeApp?.unit.active === "active" ? `访问 ${activeApp.port} 端口` : "等待启用界面"} />
    </FactGrid></SettingsCard>
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

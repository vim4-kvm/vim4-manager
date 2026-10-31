import { cn } from "@/lib/utils";
import { t, useLocale } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { ArrowRightLeft, ExternalLink, Network, RotateCw, Usb, Video } from "lucide-react";
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

const appPackages: Record<string, string> = { onekvm: "vim4-onekvm", nanokvm: "vim4-nanokvm", jetkvm: "vim4-jetkvm", pikvm: "vim4-pikvm" };

export function Applications() {
 useLocale();
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
    return run(t("apps.switchingTo", { p0: String(app.name) }), () => selectApp(app.id), t("apps.switchedTo", { p0: String(app.name) }));
  };
  useEffect(() => {
    // Cancel at navigation time even while the outgoing page finishes its fade.
    const leave = () => {
      if (location.hash === "#/apps" || !waitingRef.current) return;
      cancelWaiting();
      report("warning", t("apps.switchCanceledCheckTheCurrentStatus"));
    };
    window.addEventListener("hashchange", leave);
    return () => { window.removeEventListener("hashchange", leave); waitingRef.current = false; };
  }, []);
  useEffect(() => {
    if (!waiting || !waitingRef.current) return;
    if (stale || !status?.media?.known || status.active !== waiting.source || Date.now() - waiting.started >= 300_000) {
      cancelWaiting();
      report("warning", t("apps.switchCanceledCheckTheCurrentStatus"));
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
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border bg-card px-5 py-4 text-sm">
      <StatusLabel showGood tone={stale ? "warning" : activeApp ? unitTone(activeApp.unit) : "idle"}>
        <strong>{stale ? t("overview.connectionLost") : activeApp ? t("apps.currently", { p0: String(activeApp.unit.active === "active" ? t("apps.running") : t("apps.enabled")), p1: String(activeApp.name) }) : t("apps.noKvmEnabled")}</strong>
      </StatusLabel>
      {activeApp && <span className="inline-flex gap-1 text-muted-foreground">{t("overview.uptimeValue", { duration: since(activeApp.unit, now) ?? "—" })}</span>}
      <span className="min-w-0 break-all text-muted-foreground">{t("apps.mediaStatus", { status: stale || !status.media?.known ? t("overview.statusUnknown") : status.media.inserted ? mediaName(status.media) : t("overview.notMounted") })}</span>
      <a className="ml-auto inline-flex items-center gap-1 text-link hover:underline" href="#/media">{t("apps.manageVirtualMedia")}<ExternalLink className="size-4" /></a>
    </div>
    {waiting ? <MediaWait media={status.media} target={waiting.app.name} onCancel={cancelWaiting} />
      : <MediaSummary media={stale ? undefined : status.media} />}
    <AnimatedList items={apps} getKey={(app) => app.id} className="grid grid-cols-1 gap-4 lg:grid-cols-2" itemClassName="min-w-0 [&>div]:h-full">{(app) => {
      const selected = app.id === status.active;
      const running = app.unit.active === "active";
      const version = status.system.packages.find((pkg) => pkg.name === appPackages[app.id])?.version;
      return <SettingsCard label={app.name} className={cn("flex flex-col [&>[data-slot=settings-row]]:flex [&>[data-slot=settings-row]]:flex-1 [&>[data-slot=settings-row]>div]:flex-1", selected && "bg-muted/50 border-foreground/15")}>
        <div className="flex h-full flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">

            <Badge variant="secondary"><StatusLabel showGood={selected} tone={unitTone(app.unit)}>{unitLabel(app.unit)}</StatusLabel></Badge>{selected && <span className="text-xs text-muted-foreground">{t("apps.startAtBoot")}</span>}
          </div>
          <div className="flex items-center gap-4">
            <div className="min-w-0"><h2 className="text-xl font-medium ">{app.name}</h2><p className="mt-1 text-sm text-muted-foreground">{app.description}</p></div>
          </div>
          <dl className="mt-auto grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 border-t pt-4 text-xs">
            <dt className="text-muted-foreground">{t("apps.service")}</dt><dd className="break-all font-mono">{app.unit.name}</dd>
            {version && <><dt className="text-muted-foreground">{t("apps.version")}</dt><dd className="flex flex-wrap gap-2 break-all font-mono">{version}<DevelopmentBadge version={version} /></dd></>}
          </dl>
          <div className="flex flex-wrap gap-3 [&>button]:min-w-24 [&>a]:min-w-24 [&>*]:flex-1">
            {!app.unit.loaded ? <span className="text-muted-foreground">{t("apps.notInstalled")}</span> : selected ? <>
              <Button variant="outline" disabled={locked} onClick={() => setRestarting(app)}><RotateCw />{t("apps.restart")}</Button>
              <Button asChild className={running ? undefined : "pointer-events-none opacity-50"}>
                <a href={kvmURL(app.port, app.id)} aria-disabled={!running}>{t("overview.openApp", { name: app.name })}<ExternalLink /></a>
              </Button>
            </> : <Button variant="outline" disabled={locked || confirming?.id === app.id} onClick={() => setConfirming(app)}><ArrowRightLeft />{t("apps.switchTo", { p0: app.name })}</Button>}
          </div>
        </div>
      </SettingsCard>;
    }}</AnimatedList>
    <Notice>{t("apps.switchingClosesTheCurrentRemoteSession")}</Notice>
    <SettingsCard title={t("apps.sharedDevices")}><FactGrid>
      <Fact label={t("apps.hdmiCapture")} icon={Video} value={status.hardware.hdmi.signal ? t("overview.connected") : t("overview.noSignal")} tone={status.hardware.hdmi.signal ? "good" : "warning"} />
      <Fact label={t("overview.usbInput")} icon={Usb} value={status.hardware.usb === "configured" ? t("overview.connected") : status.hardware.usb || t("common.unknown")} tone={status.hardware.usb === "configured" ? "good" : "idle"} />
      <Fact label={t("apps.kvmGateway")} icon={Network} value={activeApp?.unit.active === "active" ? t("apps.openPort", { p0: String(activeApp.port) }) : t("apps.waitingForAnInterface")} />
    </FactGrid></SettingsCard>
    {!status.apps.some((a) => a.id === status.active) && <p className="text-sm text-muted-foreground">{t("apps.noInterfaceEnabledChooseOneTo")}</p>}
    {confirming && <ConfirmDialog open title={t("apps.switchTo", { p0: String(confirming.name) })} disabled={locked}
      description={mediaBlocked ? t("apps.aVirtualDiskIsStillMounted") : t("apps.theCurrentRemoteSessionWillDisconnect")}
      confirm={mediaBlocked ? t("apps.switchAfterEjection") : t("apps.switchTo", { p0: String(confirming.name) })}
      onOpenChange={(open) => { if (!open) setConfirming(undefined); }} onConfirm={() => {
        if (mediaBlocked) {
          waitingRef.current = true;
          setWaiting({ app: confirming, source: status.active, started: Date.now() });
          toast.dismiss();
        } else void switchApp(confirming);
        setConfirming(undefined);
      }} />}
    {restarting && <ConfirmDialog open title={t("apps.restart280", { p0: String(restarting.name) })} description={t("apps.theCurrentRemoteSessionWillDisconnect")} confirm={t("apps.restart")} disabled={locked}
      onOpenChange={(open) => { if (!open) setRestarting(undefined); }} onConfirm={() => {
        void run(t("apps.restarting", { p0: String(restarting.name) }), () => restartUnit(restarting.unit.name), t("apps.restarted", { p0: String(restarting.name) }));
        setRestarting(undefined);
      }} />}
  </>;
}

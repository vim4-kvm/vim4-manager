import { number } from "@/i18n/format";
import { t, useLocale, getLocale } from "@/i18n";
import { ArrowUpRight, ChevronDown, History, RefreshCw } from "lucide-react";
import { useId, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { BoardEvent, Hardware, Link, PowerCapability, Status } from "@/api";
import { AnimatedList } from "@/components/AnimatedList";
import { DevelopmentBadge } from "@/components/DevelopmentBadge";
import { DeviceConnections } from "@/components/DeviceConnections";
import { EmptyState } from "@/components/EmptyState";
import { Fact, FactGrid } from "@/components/FactGrid";
import { Collapse, FadeIn } from "@/components/Motion";
import { ResourceTrends } from "@/components/ResourceTrends";
import { SettingsCard } from "@/components/SettingsCard";
import { StatusDot, StatusLabel, type Tone } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { celsius, clockTime, duration, hdrLabel, kvmURL, since, tempTone, unitLabel, unitTone } from "@/lib/units";
import { cn } from "@/lib/utils";
import { baseVersion, isDevelopmentVersion } from "@/lib/version";
import { useStatusStore } from "@/stores/status";

function OverviewHeading() {
 useLocale();
  const { stale, refresh } = useStatusStore(useShallow((s) => ({ stale: s.stale, refresh: s.refresh })));
  const [busy, setBusy] = useState(false);
  async function reload() {
    setBusy(true);
    try { await refresh(); } finally { setBusy(false); }
  }
  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-col gap-1.5">
        <h1 id="page-title" className="text-2xl font-medium  md:text-3xl">{t("overview.overview")}</h1>
        <p className="text-sm text-muted-foreground">{t("overview.deviceStatusTrendsAndQuickActions")}</p>
      </div>
      <div className="flex items-center gap-3">
        <StatusLabel tone={stale ? "warning" : "good"} className="text-xs text-muted-foreground">{stale ? t("overview.connectionLost") : t("overview.autoRefresh")}</StatusLabel>
        <Button variant="outline" size="icon" aria-label={t("overview.refreshDeviceStatus")} title={t("overview.refreshDeviceStatus")} disabled={busy} onClick={() => void reload()}>
          <RefreshCw aria-hidden="true" className={cn(busy && "animate-spin motion-reduce:animate-none")} />
        </Button>
      </div>
    </header>
  );
}

function DeviceStatus({ status, now, stale }: { status: Status; now: number; stale: boolean }) {
 useLocale();
  const [open, setOpen] = useState(false);
  const panel = useId();
  const failed = [...status.platform.map((p) => p.unit), ...status.apps.filter((a) => a.id === status.active).map((a) => a.unit)].filter((unit) => unit.active === "failed").length;
  const address = status.system.links.filter((link) => link.up).flatMap((link) => link.addrs ?? []).find((addr) => !addr.includes(":"));
  return (
    <section aria-label={t("overview.deviceConnections")} className="flex h-full flex-col overflow-hidden rounded-xl border bg-card text-xs">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 px-4 py-3 @4xl:flex @4xl:flex-wrap">
      <StatusLabel showGood tone={stale ? "warning" : failed ? "critical" : "good"} className="font-medium">
        {stale ? t("overview.connectionLostLastKnownState") : failed ? t("overview.servicesNeedAttention", { count: failed }) : t("overview.deviceOnline")}
      </StatusLabel>
      <span className="min-w-0 break-all text-muted-foreground">{status.hardware.hostname}{address && <> · <span className="font-mono">{address}</span></>}</span>
      <span className="col-span-2 text-muted-foreground" title={t("overview.started", { p0: String(clockTime(now - status.hardware.uptimeSeconds * 1000, now)) })}>{t("overview.uptimeValue", { duration: duration(status.hardware.uptimeSeconds) })}</span>
      {stale && <span className="text-muted-foreground">{t("overview.lastUpdatedAt", { time: clockTime(now, Date.now()) })}</span>}
      <div className="col-span-2 flex items-center gap-3 @4xl:ml-auto">
        <a href="#/output" className={cn(linkButton, "hidden @4xl:inline-flex")}>{t("overview.viewHdmiOutput")}<ArrowUpRight aria-hidden="true" className="ml-1 inline size-4" /></a>
        <button type="button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)}
          className="@4xl:hidden inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-link outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
          {open ? t("overview.hideConnections") : t("overview.showConnections")}<ChevronDown aria-hidden="true" className={cn("size-4 transition-transform", open && "rotate-180")} />
        </button>
      </div>
      </div>
      <div className="hidden flex-1 items-center justify-center px-4 @4xl:flex"><DeviceConnections status={status} stale={stale} compact /></div>
      <div className="@4xl:hidden"><Collapse open={open}><div id={panel} className="border-t p-4"><a href="#/output" className={linkButton}>{t("overview.viewHdmiOutput")}<ArrowUpRight aria-hidden="true" className="ml-1 inline size-4" /></a><DeviceConnections status={status} stale={stale} compact /></div></Collapse></div>
      <LinkFacts hw={status.hardware} power={status.power} media={status.media} />
    </section>
  );
}

function ActiveApp({ status, now }: { status: Status; now: number }) {
 useLocale();
  const app = status.apps.find((a) => a.id === status.active);
  if (!app) return <SettingsCard title={t("overview.currentKvm")}><div className="flex flex-col gap-4"><p className="text-sm text-muted-foreground">{t("overview.noKvmInterfaceEnabled")}</p><Button asChild><a href="#/apps">{t("overview.chooseInterface")}</a></Button></div></SettingsCard>;
  const running = app.unit.active === "active";
  const uptime = since(app.unit, now);
  const version = status.system.packages.find((pkg) => pkg.name === `vim4-${app.id}`)?.version;
  return (
    <SettingsCard title={t("overview.currentKvm")}>
      <div className="flex flex-col gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h3 className="text-base font-medium">{app.name}</h3>
              <StatusLabel showGood tone={unitTone(app.unit)} className="text-xs">{unitLabel(app.unit)}</StatusLabel>
            </div>
            <p className="text-xs text-muted-foreground">{uptime ? t("overview.runningFor", { p0: String(uptime) }) : t("overview.viewKvmStatus")}</p>
            <div data-app-detail className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {version && <span data-version title={version} className="inline-flex flex-wrap items-center gap-1.5">
                <span>{isDevelopmentVersion(version) ? baseVersion(version) : version}</span><DevelopmentBadge version={version} />
              </span>}
              <span data-host className="font-mono">{location.hostname}:{app.port}</span>
            </div>
          </div>
        </div>
        <Button asChild className={cn("w-full", !running && "pointer-events-none opacity-50")}>
          <a href={kvmURL(app.port, app.id)} aria-disabled={!running}>{t("overview.openApp",{name:app.name})}<ArrowUpRight aria-hidden="true" /></a>
        </Button>
        <a href="#/apps" className="self-center rounded-sm text-xs text-link outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">{t("overview.switchKvmInterface")}</a>
      </div>
    </SettingsCard>
  );
}

function capabilityLabel(pdo: PowerCapability): string {
  const voltage = pdo.minVoltageV === pdo.maxVoltageV ? `${pdo.maxVoltageV}V` : `${pdo.minVoltageV}–${pdo.maxVoltageV}V`;
  if (pdo.maxPowerW != null) return `${pdo.type} · ${voltage} ${pdo.maxPowerW}W`;
  if (pdo.maxCurrentA != null) return `${pdo.type} · ${voltage} ${pdo.maxCurrentA}A`;
  return pdo.type;
}

function contractTime(establishedAt: string): string {
  // Keep the board's wall clock and offset, independent of the browser zone.
  const offset = Date.parse(`${establishedAt.slice(0, 19)}Z`) - Date.parse(establishedAt);
  const boardYear = new Date(Date.now() + offset).getUTCFullYear();
  const local = new Date(establishedAt.slice(0,19)+'Z');
  return new Intl.DateTimeFormat(getLocale(), { timeZone: 'UTC', year: Number(establishedAt.slice(0,4)) === boardYear ? undefined : 'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(local);
}

function PowerFact({ power, kernel }: { power: Status["power"]; kernel: string }) {
 useLocale();
  const [open, setOpen] = useState(false);
  const panel = useId();
  const fw = power?.firmwarePD;
  const linux = power?.bootContract;
  const contract = linux || fw?.contract;
  const warm = !contract && fw?.timedOut && fw.sourceCapabilities.length === 0 && power?.vbusPresent === true;
  const last = warm ? power?.lastContract : undefined;
  const lastTime = last ? contractTime(last.establishedAt) : "";
  const allowance = contract ? `${contract.voltageV}V ${contract.currentA}A` : "";
  const value = contract ? (linux ? `${contract.voltageV} V / ${contract.currentA} A` : t("overview.pdContract", { p0: String(allowance) }))
    : warm ? last ? t("overview.vARetained", { p0: String(last.voltageV), p1: String(last.currentA) }) : t("overview.typeCOnly")
    : fw ? (fw.psReady && !fw.ioError && !fw.typecFallback ? t("overview.pdReadyBudgetUnknown") : fw.typecFallback ? t("overview.typeCNoConfirmedPdContract") : t("overview.noConfirmedPdContract"))
    : power?.vbusPresent === true ? t("overview.usbCVoltageDetected") : power?.vbusPresent === false ? t("overview.noUsbCVoltageDetected") : t("overview.statusUnavailable");
  const detail = contract ? t("overview.powerBudgetW", { p0: String(+(contract.voltageV * contract.currentA).toFixed(2)), p1: String(linux ? t("overview.linuxInitialization") : t("overview.bootFirmwareNegotiation")) })
    : last ? t("overview.notRenegotiatedPrevious", { p0: String(lastTime) })
    : fw ? `${warm ? t("overview.notRenegotiated") : t("overview.bootFirmware")} · Rp ${fw.rp === "default" ? t("overview.defaultCurrent") : fw.rp === "unknown" ? t("common.unknown") : fw.rp}`
    : kernel.startsWith("7.") ? t("overview.usingBootFirmwareInitializationPowerBudget") : t("overview.noConfirmedPowerBudgetForThis");
  return (
    <Fact card label={t("overview.usbCPower")} value={value} detail={detail} href="#/services" destination={t("overview.systemServices")}>
      {fw && (
        <div data-pd-capabilities className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          <button type="button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)}
            className="relative z-10 inline-flex items-center gap-1 rounded-sm text-left outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
            {fw.sourceCapabilities.length ? t("overview.sourceCapabilitiesCount", { count: fw.sourceCapabilities.length }) : t("overview.sourceCapabilitiesMissing")}
            <ChevronDown aria-hidden="true" className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
          </button>
          <Collapse open={open}>
            <div id={panel} className="relative z-10 flex flex-col gap-2 pt-2">
              {warm ? <>
                <p>{t("overview.timedOutWaitingForSourceCapabilities")}</p>
                <p>{last ? t("overview.previousContractVA", { p0: String(last.voltageV), p1: String(last.currentA), p2: String(last.usbComm ? t("overview.usbData") : ""), p3: String(last.origin === "linux" ? t("overview.linuxInitialization") : t("overview.bootFirmwareNegotiation")), p4: String(lastTime) }) : t("overview.reconnectUsbCPowerToRead")}</p>
              </> : <>
                <p>{t("overview.firmwareStatus", { status: fw.contract ? `${number(fw.contract.voltageV)} V ${number(fw.contract.currentA)} A` : fw.psReady ? t("overview.psRdyReceived") : t("overview.pdContractIncomplete") })}</p>
                {fw.sourceRevision && <p>{t("overview.pdRevisions", { source: fw.sourceRevision, requested: fw.requestRevision || t("common.unknown") })}</p>}
                {fw.requestedCurrentA != null && <p>{t("overview.currentRequest", { current: fw.requestedCurrentA, max: fw.requestedMaxCurrentA ?? 0 })}</p>}
                {fw.requestedPowerW != null && <p>{t("overview.powerRequest", { current: fw.requestedPowerW, max: fw.requestedMaxPowerW ?? 0 })}</p>}
              </>}
              {(fw.hardReset || fw.requestFailed || (!warm && fw.timedOut) || fw.ioError) && <p>{[fw.hardReset && t("overview.hardReset"), fw.requestFailed && t("overview.requestFailedOrDeferred"), !warm && fw.timedOut && t("overview.initializationTimedOut"), fw.ioError && t("overview.readFailed")].filter(Boolean).join(" · ")}</p>}
              {!warm && <ul className="flex flex-col">{fw.sourceCapabilities.map((pdo) => (
                <li key={pdo.position} className="grid gap-0.5 border-t py-1.5">
                  <span>PDO {pdo.position}{fw.selectedPosition === pdo.position ? t("overview.requested") : ""}</span>
                  <span className="text-foreground">{capabilityLabel(pdo)}</span>
                  <code className="font-mono text-xs">0x{pdo.raw}</code>
                </li>
              ))}</ul>}
              <p>{t("overview.bootNegotiationRecordDoesNotMeasure")}</p>
            </div>
          </Collapse>
        </div>
      )}
    </Fact>
  );
}


function LinkFacts({ hw, power, media }: { hw: Hardware; power: Status["power"]; media: Status["media"] }) {
 useLocale();
  const h = hw.hdmi;
  const hdmiDetail = h.signal
    ? [h.refreshHz != null ? `${number(h.refreshHz, { maximumFractionDigits: 2 })} Hz` : undefined, h.colorSpace, hdrLabel(h.hdr), h.audio ? t("overview.audio") : t("overview.noAudio")].filter(Boolean).join(" · ")
    : t("overview.checkTheTargetComputerSHdmi");
  const capture = h.signal && h.captureWidth && h.captureHeight && (h.captureWidth !== h.width || h.captureHeight !== h.height)
    ? t("overview.capture", { p0: String(h.captureWidth), p1: String(h.captureHeight) }) : undefined;
  const usbConfigured = hw.usb === "configured";
  const mediaKnown = media?.known;
  return (
    <FactGrid cols={4} className="grid-cols-2 gap-0 border-t @4xl:grid-cols-4 [&>div:nth-child(odd)]:border-r [&>div:nth-child(-n+2)]:border-b @4xl:[&>div:not(:last-child)]:border-r @4xl:[&>div:nth-child(-n+2)]:border-b-0">
      <Fact card label={t("overview.hdmiInput")} href="#/video" destination={t("overview.videoInput")} value={h.signal ? <>{h.width}×<wbr />{h.height}</> : t("overview.noSignal")}
        valueKey={h.signal ? `${h.width}×${h.height}` : t("overview.noSignal")} detail={[hdmiDetail, capture].filter(Boolean).join(" · ")} tone={h.signal ? "good" : "warning"} />
      <Fact card label={t("overview.usbInput")} href="#/services" destination={t("overview.systemServices")} value={usbConfigured ? t("overview.connected") : hw.usb || t("common.unknown")}
        detail={usbConfigured ? t("overview.keyboardAndMouseDetected") : t("overview.waitingForTheTargetComputer")} tone={usbConfigured ? "good" : "warning"} />
      <PowerFact power={power} kernel={hw.kernel} />
      <Fact card hideDot={mediaKnown && !media.inserted} mutedValue={mediaKnown && !media.inserted} label={t("overview.virtualMedia")} href="#/media" destination={t("overview.virtualMedia")} className="[overflow-wrap:anywhere]"
        value={!mediaKnown ? t("overview.statusUnknown") : media.inserted ? (media.cdrom ? t("overview.discMounted") : t("overview.diskMounted")) : t("overview.notMounted")}
        detail={!mediaKnown ? t("overview.openVirtualMedia") : media.inserted ? `${media.name || t("overview.mountedMedia")} · ${media.readOnly ? t("overview.readOnly") : t("overview.writable")}` : t("overview.chooseAnImageToMountOn")}
        tone={!mediaKnown ? "idle" : media.inserted ? (media.connected ? "good" : "warning") : "idle"} />
    </FactGrid>
  );
}

const linkButton = "self-start rounded-sm text-xs text-link outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

function EventList({ events, now }: { events: BoardEvent[]; now: number }) {
 useLocale();
  const [all, setAll] = useState(false);
  const shown = all ? events : events.slice(0, 3);
  if (!events.length) return <EmptyState icon={History}>{t("overview.noEventsYet")}</EmptyState>;
  return (
    <div className="flex flex-col gap-2">
      <AnimatedList as="ol" className="flex flex-col" items={shown} getKey={(e) => `${e.t}-${e.text}`}>{(e) => (
          <div data-event={e.tone} className="grid grid-cols-[64px_8px_minmax(0,1fr)] items-center gap-3 py-1.5 text-sm">
            <time className="text-xs text-muted-foreground tabular-nums" dateTime={new Date(e.t).toISOString()}>
              {clockTime(e.t, now)}
            </time>
            <StatusDot tone={e.tone === "good" ? "idle" : e.tone} className={(e.tone === "good" || e.tone === "idle") ? "bg-muted-foreground/40" : undefined} />
            <span className={cn(e.tone === "critical" && "text-destructive")}>{e.text}</span>
          </div>
        )}</AnimatedList>
      {events.length > shown.length && (
        <button type="button" className={linkButton} onClick={() => setAll(true)}>
          {t("overview.eventCount", { count: events.length })}</button>
      )}
    </div>
  );
}


function Addresses({ addrs }: { addrs: string[] }) {
 useLocale();
  const v4 = addrs.filter((a) => !a.includes(":"));
  const v6 = addrs.filter((a) => a.includes(":"));
  if (!addrs.length) return <span className="text-muted-foreground">—</span>;
  return (
    <>
      {v4.map((a) => <span key={a} className="font-mono text-xs">{a}</span>)}
      {v6.length > 0 && (
        <span className="cursor-help text-xs text-muted-foreground" title={v6.join("\n")}>
          {v4.length ? t("overview.ipv", { p0: String(v6.length) }) : v6[0]}
        </span>
      )}
    </>
  );
}

function NetworkList({ links }: { links: Link[] }) {
 useLocale();
  if (!links.length) return <p className="text-sm text-muted-foreground">{t("overview.noNetworkAdaptersDetected")}</p>;
  // Idle radios carry no address; one summary line instead of a row of dashes per interface.
  const idleWifi = links.filter((l) => l.wireless && !l.up);
  const shown = idleWifi.length > 1 ? links.filter((l) => !idleWifi.includes(l)) : links;
  return (
    <ul className="flex flex-col divide-y">
      {shown.map((l) => (
        <li key={l.name} className="flex flex-wrap items-baseline gap-x-1 gap-y-0.5 py-2 first:pt-0 last:pb-0">
          <StatusLabel tone={l.up ? "good" : "idle"} className="text-sm">
            {l.wireless ? `Wi-Fi ${l.name}` : l.name === "usb0" ? t("overview.usbNetworkAdapter") : t("overview.ethernet", { p0: String(l.name) })}
          </StatusLabel>
          <span className="text-xs text-muted-foreground tabular-nums">
            · {l.up ? (l.speedMbps ? (l.speedMbps >= 1000 ? `${l.speedMbps / 1000} Gbps` : `${l.speedMbps} Mbps`) : t("overview.connected")) : t("overview.notConnected")}
          </span>
          <span className="flex w-full flex-wrap items-baseline gap-x-2.5 gap-y-0.5 [overflow-wrap:anywhere]">
            <Addresses addrs={l.addrs ?? []} />
          </span>
        </li>
      ))}
      {shown.length < links.length && (
        <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 py-2 last:pb-0">
          <StatusLabel tone="idle" className="text-sm">Wi-Fi {idleWifi.map((l) => l.name).join("、")}</StatusLabel>
          <span className="text-right text-xs text-muted-foreground">{t("overview.notConnected")}</span>
        </li>
      )}
    </ul>
  );
}



function compactUsage(used: number, total: number): string {
  const format = (value: number) => {
    const unit = value >= 2 ** 40 ? "TiB" : value >= 2 ** 30 ? "GiB" : "MiB";
    const divisor = unit === "TiB" ? 2 ** 40 : unit === "GiB" ? 2 ** 30 : 2 ** 20;
    return { value: number(value / divisor, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), unit };
  };
  const a = format(used), b = format(total);
  return t("overview.compactUsage", { used: a.unit === b.unit ? a.value : a.value + " " + a.unit, total: b.value + " " + b.unit });
}

function Meter({ label, fraction }: { label: string; fraction: number }) {
 useLocale();
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div className="mt-2 flex items-center gap-2">
      <span role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="block h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span className={cn("block h-full rounded-full", pct > 90 ? "bg-destructive-fill" : pct > 80 ? "bg-warning" : "bg-chart-1")} style={{ width: `${pct}%` }} />
      </span><span className="text-xs font-normal text-muted-foreground">{pct}%</span>
    </div>
  );
}

function DeviceHealth({ status, stale }: { status: Status; stale: boolean }) {
 useLocale();
  const hw = status.hardware;
  const disk = status.system.disk;
  const memUsed = hw.memTotalKiB ? 1 - hw.memAvailableKiB / hw.memTotalKiB : undefined;
  const diskUsed = disk.totalBytes ? 1 - disk.freeBytes / disk.totalBytes : undefined;
  const incomplete = memUsed === undefined || diskUsed === undefined;
  const high = hw.tempC >= 85 || (memUsed ?? 0) > 0.9 || (diskUsed ?? 0) > 0.9;
  const warm = hw.tempC >= 70 || (memUsed ?? 0) > 0.8 || (diskUsed ?? 0) > 0.8;
  const tone: Tone = stale || incomplete ? "idle" : high ? "critical" : warm ? "warning" : "good";
  return (
    <SettingsCard title={t("overview.deviceHealth")} action={<StatusLabel tone={tone} className="text-xs">{stale ? t("overview.lastKnownState") : incomplete ? t("overview.someReadingsUnavailable") : high ? t("overview.needsAttention") : warm ? t("overview.highUsage") : t("overview.normal")}</StatusLabel>}>
      <div className="grid grid-cols-2 gap-5 @4xl:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,2fr)]">
      <dl className="contents text-xs">
        <div><dt className="text-muted-foreground">{t("overview.socTemperature")}</dt><dd className="mt-2 flex items-center gap-2 text-sm font-medium tabular-nums">{tempTone(hw.tempC) !== "good" && <StatusDot tone={tempTone(hw.tempC)} />}{celsius(hw.tempC)}</dd></div>
        <div><dt className="text-muted-foreground">{t("overview.fan")}</dt><dd className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm font-medium tabular-nums">{hw.fanPercent > 0 ? t(hw.fanAuto ? "overview.fanAuto" : "overview.fanManual", {percent:hw.fanPercent}) : t("overview.stopped")}</dd></div>
        <div className="min-w-0"><dt className="text-muted-foreground">{t("overview.memory")}</dt><dd className="mt-2 text-xs font-medium tabular-nums">{memUsed === undefined ? t("common.unknown") : compactUsage((hw.memTotalKiB - hw.memAvailableKiB) * 1024, hw.memTotalKiB * 1024)}{memUsed !== undefined && <Meter label={t("overview.memoryUsage")} fraction={memUsed} />}</dd></div>
        <div className="min-w-0"><dt className="text-muted-foreground">{t("overview.systemDisk")}</dt><dd className="mt-2 text-xs font-medium tabular-nums">{diskUsed === undefined ? t("common.unknown") : compactUsage(disk.totalBytes - disk.freeBytes, disk.totalBytes)}{diskUsed !== undefined && <Meter label={t("overview.systemDiskUsage")} fraction={diskUsed} />}</dd></div>
      </dl>
      <NetworkList links={status.system.links} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <a className={linkButton} href="#/cooling">{t("overview.coolingSettings")}</a><a className={linkButton} href="#/updates">{t("overview.viewComponentVersions")}</a>
      </div>
    </SettingsCard>
  );
}

function OverviewSkeleton() {
 useLocale();
  return (
    <div className="@container flex flex-col gap-4" aria-busy="true">
      <span className="sr-only">{t("common.loading")}</span><Skeleton className="h-12 rounded-lg" />
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3"><Skeleton className="h-[480px] rounded-xl @4xl:col-span-2" /><div className="grid gap-4"><Skeleton className="h-60 rounded-xl" /><Skeleton className="h-56 rounded-xl" /></div></div>
      <Skeleton className="h-[560px] rounded-xl" />
      <Skeleton className="h-48 rounded-xl" />
    </div>
  );
}

export function Overview() {
 useLocale();
  const { status, now, stale } = useStatusStore(useShallow((s) => ({ status: s.status, now: s.now, stale: s.stale })));
  return (
    <div className="@container flex flex-col gap-6">
      <OverviewHeading />
      {!status ? <OverviewSkeleton /> : <FadeIn className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
          <div className="min-w-0 @4xl:col-span-2 @4xl:row-span-2"><DeviceStatus status={status} now={now} stale={stale} /></div>
          <div className="min-w-0"><ActiveApp status={status} now={now} /></div>
          <div className="min-w-0 @4xl:col-span-3 @4xl:row-start-3"><ResourceTrends hw={status.hardware} history={status.history} now={now} /></div>
          <SettingsCard className="@4xl:col-start-3 @4xl:row-start-2" title={t("overview.recentEvents")} description={t("overview.signalUsbServiceAndActionHistory")}>
            <EventList events={status.events} now={now} />
            <p className="text-xs text-muted-foreground">{t("overview.eventHistoryResetsWhenTheManager")}</p>
          </SettingsCard>
        </div>
        <DeviceHealth status={status} stale={stale} />
      </FadeIn>}
    </div>
  );
}


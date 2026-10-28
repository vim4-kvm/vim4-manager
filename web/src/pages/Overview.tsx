import { ArrowUpRight, ChevronDown, Disc3, History, MonitorPlay, Plug, RefreshCw, Zap } from "lucide-react";
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
  const { stale, refresh } = useStatusStore(useShallow((s) => ({ stale: s.stale, refresh: s.refresh })));
  const [busy, setBusy] = useState(false);
  async function reload() {
    setBusy(true);
    try { await refresh(); } finally { setBusy(false); }
  }
  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-col gap-1.5">
        <h1 id="page-title" className="text-2xl font-bold tracking-tight md:text-3xl">概览</h1>
        <p className="text-sm text-muted-foreground">设备状态、资源趋势与常用操作。</p>
      </div>
      <div className="flex items-center gap-3">
        <StatusLabel tone={stale ? "warning" : "good"} className="text-xs text-muted-foreground">{stale ? "连接中断" : "自动刷新"}</StatusLabel>
        <Button variant="outline" size="icon" aria-label="刷新设备状态" title="刷新设备状态" disabled={busy} onClick={() => void reload()}>
          <RefreshCw aria-hidden="true" className={cn(busy && "animate-spin motion-reduce:animate-none")} />
        </Button>
      </div>
    </header>
  );
}

function DeviceStatus({ status, now, stale }: { status: Status; now: number; stale: boolean }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const failed = [...status.platform.map((p) => p.unit), ...status.apps.filter((a) => a.id === status.active).map((a) => a.unit)].filter((unit) => unit.active === "failed").length;
  const address = status.system.links.filter((link) => link.up).flatMap((link) => link.addrs ?? []).find((addr) => !addr.includes(":"));
  return (
    <section aria-label="设备连接状态" className="overflow-hidden rounded-lg border bg-card text-xs">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <StatusLabel tone={stale ? "warning" : failed ? "critical" : "good"} className="font-medium">
        {stale ? "连接中断 · 显示上次状态" : failed ? `${failed} 项服务异常` : "设备在线"}
      </StatusLabel>
      <span className="min-w-0 break-all text-muted-foreground">{status.hardware.hostname}{address && <> · <span className="font-mono">{address}</span></>}</span>
      <span className="text-muted-foreground" title={`开机于 ${clockTime(now - status.hardware.uptimeSeconds * 1000, now)}`}>已运行 {duration(status.hardware.uptimeSeconds)}</span>
      {stale && <span className="text-muted-foreground">上次更新 {clockTime(now, Date.now())}</span>}
      <div className="ml-auto flex items-center gap-3">
        <button type="button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-link outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
          {open ? "收起连接状态" : "展开连接状态"}<ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </button>
      </div>
      </div>
      <Collapse open={open}>
        <div id={panel} className="border-t p-4 sm:p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">设备连接</h2>
            <a href="#/output" className="inline-flex items-center gap-1 rounded-sm text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">查看 HDMI 输出<ArrowUpRight aria-hidden="true" className="size-3.5" /></a>
          </div>
          <DeviceConnections status={status} stale={stale} />
        </div>
      </Collapse>
    </section>
  );
}

function ActiveApp({ status, now }: { status: Status; now: number }) {
  const app = status.apps.find((a) => a.id === status.active);
  if (!app) return <SettingsCard title="当前 KVM"><div className="flex flex-col gap-4"><p className="text-sm text-muted-foreground">还没有启用 KVM 界面。</p><Button asChild><a href="#/apps">选择界面</a></Button></div></SettingsCard>;
  const running = app.unit.active === "active";
  const uptime = since(app.unit, now);
  const version = status.system.packages.find((pkg) => pkg.name === `vim4-${app.id}`)?.version;
  return (
    <SettingsCard title="当前 KVM">
      <div className="flex flex-col gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <MonitorPlay aria-hidden="true" className="mt-1 size-8 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h3 className="text-base font-semibold">{app.name}</h3>
              <StatusLabel tone={unitTone(app.unit)} className="text-xs">{unitLabel(app.unit)}</StatusLabel>
            </div>
            <p className="text-xs text-muted-foreground">{uptime ? `已运行 ${uptime}` : "查看 KVM 界面管理运行状态"}</p>
            <div data-app-detail className="flex min-w-0 flex-col gap-1 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
              {version && <span data-version title={version} className="inline-flex flex-wrap items-center gap-1.5">
                <span>{isDevelopmentVersion(version) ? baseVersion(version) : version}</span><DevelopmentBadge version={version} />
              </span>}
              <span data-host className="font-mono">{location.hostname}:{app.port}</span>
            </div>
          </div>
        </div>
        <Button asChild className={cn("w-full", !running && "pointer-events-none opacity-50")}>
          <a href={kvmURL(app.port, app.id)} aria-disabled={!running}>打开 {app.name}<ArrowUpRight aria-hidden="true" /></a>
        </Button>
        <a href="#/apps" className="self-center rounded-sm text-xs text-link outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">切换 KVM 界面</a>
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
  return establishedAt.slice(Number(establishedAt.slice(0, 4)) === boardYear ? 5 : 0, 16).replace("T", " ");
}

function PowerFact({ power, kernel }: { power: Status["power"]; kernel: string }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const fw = power?.firmwarePD;
  const linux = power?.bootContract;
  const contract = linux || fw?.contract;
  const warm = !contract && fw?.timedOut && fw.sourceCapabilities.length === 0 && power?.vbusPresent === true;
  const last = warm ? power?.lastContract : undefined;
  const lastTime = last ? contractTime(last.establishedAt) : "";
  const allowance = contract ? `${contract.voltageV}V ${contract.currentA}A` : "";
  const value = contract ? (linux ? `${contract.voltageV} V / ${contract.currentA} A` : `PD 合同 · ${allowance}`)
    : warm ? last ? `${last.voltageV}V ${last.currentA}A · 沿用` : "仅 Type-C"
    : fw ? (fw.psReady && !fw.ioError && !fw.typecFallback ? "PD 已就绪 · 额度不可确认" : fw.typecFallback ? "Type-C · 无确认的 PD 合同" : "无确认的 PD 合同")
    : power?.vbusPresent === true ? "已检测到 USB-C 电压" : power?.vbusPresent === false ? "未检测到 USB-C 电压" : "状态不可读";
  const detail = contract ? `供电额度 ${+(contract.voltageV * contract.currentA).toFixed(2)} W · ${linux ? "Linux 初始化" : "启动固件协商"}`
    : last ? `本次未重新协商 · 上次 ${lastTime}`
    : fw ? `${warm ? "本次未重新协商" : "启动固件"} · Rp ${fw.rp === "default" ? "默认电流" : fw.rp === "unknown" ? "未知" : fw.rp}`
    : kernel.startsWith("7.") ? "沿用启动固件初始化 · 协商额度不可读" : "本次开机无可确认的协商额度";
  return (
    <Fact card icon={Zap} label="PD 协商" value={value} detail={detail} href={fw ? undefined : "#/services"} destination="底层服务">
      {fw && (
        <div data-pd-capabilities className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          <button type="button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)}
            className="inline-flex items-center gap-1 rounded-sm text-left outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
            来源能力 · {fw.sourceCapabilities.length ? `${fw.sourceCapabilities.length} 项` : "本次未收到"}
            <ChevronDown aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
          </button>
          <Collapse open={open}>
            <div id={panel} className="flex flex-col gap-2 pt-2">
              {warm ? <>
                <p>等待来源能力超时（热重启时供电端不重发）</p>
                <p>{last ? `上次合同 · ${last.voltageV}V ${last.currentA}A${last.usbComm ? " · USB 数据" : ""} · ${last.origin === "linux" ? "Linux 初始化" : "启动固件协商"} · ${lastTime}` : "冷插拔 USB-C 后可读取完整协商"}</p>
              </> : <>
                <p>启动固件 · {fw.contract ? `${fw.contract.voltageV}V ${fw.contract.currentA}A` : fw.psReady ? "已收到 PS_RDY" : "未完成 PD 合同"}</p>
                {fw.sourceRevision && <p>来源 PD {fw.sourceRevision} · 请求 PD {fw.requestRevision || "未知"}</p>}
                {fw.requestedCurrentA != null && <p>工作请求 {fw.requestedCurrentA}A · 最大请求 {fw.requestedMaxCurrentA}A</p>}
                {fw.requestedPowerW != null && <p>工作请求 {fw.requestedPowerW}W · 最大请求 {fw.requestedMaxPowerW}W</p>}
              </>}
              {(fw.hardReset || fw.requestFailed || (!warm && fw.timedOut) || fw.ioError) && <p>{[fw.hardReset && "发生硬复位", fw.requestFailed && "请求失败/延后", !warm && fw.timedOut && "初始化超时", fw.ioError && "读取异常"].filter(Boolean).join(" · ")}</p>}
              {!warm && <ul className="flex flex-col">{fw.sourceCapabilities.map((pdo) => (
                <li key={pdo.position} className="grid gap-0.5 border-t py-1.5">
                  <span>PDO {pdo.position}{fw.selectedPosition === pdo.position ? " · 已请求" : ""}</span>
                  <span className="text-foreground">{capabilityLabel(pdo)}</span>
                  <code className="font-mono text-[11px]">0x{pdo.raw}</code>
                </li>
              ))}</ul>}
              <p>启动协商记录；不代表实时电流或功耗</p>
            </div>
          </Collapse>
        </div>
      )}
    </Fact>
  );
}


function LinkFacts({ hw, power, media }: { hw: Hardware; power: Status["power"]; media: Status["media"] }) {
  const h = hw.hdmi;
  const hdmiDetail = h.signal
    ? [h.refreshHz != null ? `${h.refreshHz.toFixed(2).replace(/\.?0+$/, "")} Hz` : undefined, h.colorSpace, hdrLabel(h.hdr), h.audio ? "有声音" : "无声音"].filter(Boolean).join(" · ")
    : "检查被控机 HDMI 输出";
  const capture = h.signal && h.captureWidth && h.captureHeight && (h.captureWidth !== h.width || h.captureHeight !== h.height)
    ? `采集 ${h.captureWidth}×${h.captureHeight}` : undefined;
  const usbConfigured = hw.usb === "configured";
  const mediaKnown = media?.known;
  return (
    <FactGrid cols={4} className="grid-cols-2 gap-3 @md:gap-4 [&>div]:p-3 @md:[&>div]:p-4 [&>div]:shadow-none">
      <Fact card icon={MonitorPlay} label="HDMI 输入" href="#/video" destination="视频输入" value={h.signal ? <>{h.width}×<wbr />{h.height}</> : "无信号"}
        valueKey={h.signal ? `${h.width}×${h.height}` : "无信号"} detail={[hdmiDetail, capture].filter(Boolean).join(" · ")} tone={h.signal ? "good" : "warning"} />
      <Fact card icon={Plug} label="USB 键鼠" href="#/services" destination="底层服务" value={usbConfigured ? "已连接" : hw.usb || "未知"}
        detail={usbConfigured ? "键盘与鼠标已枚举" : "等待被控机枚举"} tone={usbConfigured ? "good" : "warning"} />
      <PowerFact power={power} kernel={hw.kernel} />
      <Fact card icon={Disc3} label="虚拟介质" href="#/media" destination="虚拟介质" className="[overflow-wrap:anywhere]"
        value={!mediaKnown ? "状态未知" : media.inserted ? (media.cdrom ? "光盘已挂载" : "磁盘已挂载") : "未挂载"}
        detail={!mediaKnown ? "打开虚拟介质查看" : media.inserted ? `${media.name || "已挂载介质"} · ${media.readOnly ? "只读" : "可写"}` : "选择镜像后挂载到被控电脑"}
        tone={!mediaKnown ? "idle" : media.inserted ? (media.connected ? "good" : "warning") : "idle"} />
    </FactGrid>
  );
}

const linkButton = "self-start rounded-sm text-xs text-link outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

function EventList({ events, now }: { events: BoardEvent[]; now: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? events : events.slice(0, 3);
  if (!events.length) return <EmptyState icon={History}>暂无事件</EmptyState>;
  return (
    <div className="flex flex-col gap-2">
      <AnimatedList as="ol" className="flex flex-col" items={shown} getKey={(e) => `${e.t}-${e.text}`}>{(e) => (
          <div data-event={e.tone} className="grid grid-cols-[64px_8px_minmax(0,1fr)] items-center gap-3 py-1.5 text-sm">
            <time className="text-xs text-muted-foreground tabular-nums" dateTime={new Date(e.t).toISOString()}>
              {clockTime(e.t, now)}
            </time>
            <StatusDot tone={e.tone} />
            <span className={cn(e.tone === "critical" && "text-destructive")}>{e.text}</span>
          </div>
        )}</AnimatedList>
      {events.length > shown.length && (
        <button type="button" className={linkButton} onClick={() => setAll(true)}>
          显示全部 {events.length} 条
        </button>
      )}
    </div>
  );
}


function Addresses({ addrs }: { addrs: string[] }) {
  const v4 = addrs.filter((a) => !a.includes(":"));
  const v6 = addrs.filter((a) => a.includes(":"));
  if (!addrs.length) return <span className="text-muted-foreground">—</span>;
  return (
    <>
      {v4.map((a) => <span key={a} className="font-mono text-xs">{a}</span>)}
      {v6.length > 0 && (
        <span className="cursor-help text-xs text-muted-foreground" title={v6.join("\n")}>
          {v4.length ? `+ ${v6.length} 个 IPv6` : v6[0]}
        </span>
      )}
    </>
  );
}

function NetworkList({ links }: { links: Link[] }) {
  if (!links.length) return <p className="text-sm text-muted-foreground">没有检测到网卡。</p>;
  // Idle radios carry no address; one summary line instead of a row of dashes per interface.
  const idleWifi = links.filter((l) => l.wireless && !l.up);
  const shown = idleWifi.length > 1 ? links.filter((l) => !idleWifi.includes(l)) : links;
  return (
    <ul className="flex flex-col divide-y">
      {shown.map((l) => (
        <li key={l.name} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 py-2 first:pt-0 last:pb-0">
          <StatusLabel tone={l.up ? "good" : "idle"} className="text-sm">
            {l.wireless ? `Wi-Fi ${l.name}` : l.name === "usb0" ? "USB 网卡" : `有线 ${l.name}`}
          </StatusLabel>
          <span className="text-right text-xs text-muted-foreground tabular-nums">
            {l.up ? (l.speedMbps ? (l.speedMbps >= 1000 ? `${l.speedMbps / 1000} Gbps` : `${l.speedMbps} Mbps`) : "已连接") : "未连接"}
          </span>
          <span className="col-span-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 pl-4 [overflow-wrap:anywhere]">
            <Addresses addrs={l.addrs ?? []} />
          </span>
        </li>
      ))}
      {shown.length < links.length && (
        <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 py-2 last:pb-0">
          <StatusLabel tone="idle" className="text-sm">Wi-Fi {idleWifi.map((l) => l.name).join("、")}</StatusLabel>
          <span className="text-right text-xs text-muted-foreground">未连接</span>
        </li>
      )}
    </ul>
  );
}


function bytes(value: number): string {
  return value >= 2 ** 40 ? `${(value / 2 ** 40).toFixed(1)} TiB` : `${(value / 2 ** 30).toFixed(1)} GiB`;
}

function Meter({ label, fraction }: { label: string; fraction: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div className="mt-2 flex items-center gap-2">
      <span role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="block h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span className={cn("block h-full rounded-full", pct > 90 ? "bg-destructive-fill" : pct > 80 ? "bg-warning" : "bg-chart-1")} style={{ width: `${pct}%` }} />
      </span><span className="text-[11px] font-normal text-muted-foreground">{pct}%</span>
    </div>
  );
}

function DeviceHealth({ status, stale }: { status: Status; stale: boolean }) {
  const hw = status.hardware;
  const disk = status.system.disk;
  const memUsed = hw.memTotalKiB ? 1 - hw.memAvailableKiB / hw.memTotalKiB : undefined;
  const diskUsed = disk.totalBytes ? 1 - disk.freeBytes / disk.totalBytes : undefined;
  const incomplete = memUsed === undefined || diskUsed === undefined;
  const high = hw.tempC >= 85 || (memUsed ?? 0) > 0.9 || (diskUsed ?? 0) > 0.9;
  const warm = hw.tempC >= 70 || (memUsed ?? 0) > 0.8 || (diskUsed ?? 0) > 0.8;
  const tone: Tone = stale || incomplete ? "idle" : high ? "critical" : warm ? "warning" : "good";
  return (
    <SettingsCard title="设备健康" action={<StatusLabel tone={tone} className="text-xs">{stale ? "上次状态" : incomplete ? "部分指标未知" : high ? "需要关注" : warm ? "占用偏高" : "正常"}</StatusLabel>}>
      <div className="grid gap-5 @4xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] @4xl:gap-8">
      <dl className="grid grid-cols-2 gap-x-5 gap-y-5 text-xs @2xl:grid-cols-4">
        <div><dt className="text-muted-foreground">SoC 温度</dt><dd className="mt-2 flex items-center gap-2 text-sm font-semibold tabular-nums"><StatusDot tone={tempTone(hw.tempC)} />{celsius(hw.tempC)}</dd></div>
        <div><dt className="text-muted-foreground">风扇</dt><dd className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm font-semibold tabular-nums">{hw.fanPercent > 0 ? `${hw.fanPercent}%` : "停转"}<span className="text-xs font-normal text-muted-foreground">{hw.fanAuto ? "自动" : "手动"} · 占空比</span></dd></div>
        <div className="min-w-0"><dt className="text-muted-foreground">内存</dt><dd className="mt-2 text-xs font-medium tabular-nums">{memUsed === undefined ? "未知" : `${bytes((hw.memTotalKiB - hw.memAvailableKiB) * 1024)} / ${bytes(hw.memTotalKiB * 1024)}`}{memUsed !== undefined && <Meter label="内存使用率" fraction={memUsed} />}</dd></div>
        <div className="min-w-0"><dt className="text-muted-foreground">系统盘</dt><dd className="mt-2 text-xs font-medium tabular-nums">{diskUsed === undefined ? "未知" : `${bytes(disk.totalBytes - disk.freeBytes)} / ${bytes(disk.totalBytes)}`}{diskUsed !== undefined && <Meter label="系统盘使用率" fraction={diskUsed} />}</dd></div>
      </dl>
      <NetworkList links={status.system.links} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <a className={linkButton} href="#/cooling">散热设置</a><a className={linkButton} href="#/updates">查看组件版本</a>
      </div>
    </SettingsCard>
  );
}

function OverviewSkeleton() {
  return (
    <div className="@container flex flex-col gap-4" aria-busy="true">
      <span className="sr-only">正在读取…</span><Skeleton className="h-12 rounded-lg" />
      <div className="grid grid-cols-2 gap-3 @md:gap-4 @4xl:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)}</div>
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3"><Skeleton className="h-[410px] rounded-xl @4xl:col-span-2" /><Skeleton className="h-[410px] rounded-xl" /></div>
      <Skeleton className="h-48 rounded-xl" />
    </div>
  );
}

export function Overview() {
  const { status, now, stale } = useStatusStore(useShallow((s) => ({ status: s.status, now: s.now, stale: s.stale })));
  return (
    <div className="@container flex flex-col gap-6">
      <OverviewHeading />
      {!status ? <OverviewSkeleton /> : <FadeIn className="flex flex-col gap-4">
        <DeviceStatus status={status} now={now} stale={stale} />
        <LinkFacts hw={status.hardware} power={status.power} media={status.media} />
        <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-3">
          <div className="min-w-0 @4xl:col-span-2"><ResourceTrends hw={status.hardware} history={status.history} now={now} /></div>
          <div className="grid min-w-0 grid-cols-1 gap-4 @xl:grid-cols-2 @4xl:grid-cols-1">
            <ActiveApp status={status} now={now} />
            <SettingsCard title="最近事件" description="信号、USB、服务与操作记录。">
              <EventList events={status.events} now={now} />
              <p className="text-xs text-muted-foreground">管理服务重启后事件记录重新开始。</p>
            </SettingsCard>
          </div>
        </div>
        <DeviceHealth status={status} stale={stale} />
      </FadeIn>}
    </div>
  );
}


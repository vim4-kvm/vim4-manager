import { ArrowUpRight, Clock3, Cpu, Fan, History, MemoryStick, MonitorPlay, Network, Plug, Thermometer, Zap, type LucideIcon } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { AnimatedList } from "@/components/AnimatedList";
import { useId, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown } from "lucide-react";
import type { BoardEvent, Hardware, Link, PowerCapability, Sample, Status, System, Zone } from "@/api";
import { DevelopmentBadge } from "@/components/DevelopmentBadge";
import { Fact, FactGrid } from "@/components/FactGrid";
import { Collapse, FadeIn } from "@/components/Motion";
import { SettingsCard } from "@/components/SettingsCard";
import { StatusDot, StatusLabel, type Tone } from "@/components/StatusDot";
import { TrendChart, samplingWindow, tempDomain, type Point } from "@/components/TrendChart";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { celsius, clockTime, duration, kvmURL, since, tempTone, unitLabel, unitTone } from "@/lib/units";
import { cn } from "@/lib/utils";
import { baseVersion, isDevelopmentVersion } from "@/lib/version";
import { useStatusStore } from "@/stores/status";

// hdmi_hdr_status values: "SDR", "HDR10-GAMMA_ST2084", "HDR10-GAMMA_HLG", "HDR10Plus-VSIF", ...
function hdrLabel(status?: string): string | undefined {
  if (!status) return undefined;
  if (status === "SDR") return "SDR";
  if (status.includes("HLG")) return "HLG";
  if (status.includes("Plus")) return "HDR10+";
  if (status.startsWith("HDR")) return "HDR10";
  return status;
}

function ActiveApp({ status, now }: { status: Status; now: number }) {
  const app = status.apps.find((a) => a.id === status.active);
  if (!app) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="mr-auto text-sm text-muted-foreground">还没有启用 KVM 界面。</span>
        <Button asChild><a href="#/apps">选择界面</a></Button>
      </div>
    );
  }
  const running = app.unit.active === "active";
  const uptime = since(app.unit, now);
  const version = status.system.packages.find((pkg) => pkg.name === `vim4-${app.id}`)?.version;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-xl border bg-muted/50"><MonitorPlay className="size-5 text-muted-foreground" /></span>
      <div className="mr-auto flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-base font-semibold tracking-tight">{app.name}</h2>
          <StatusLabel tone={unitTone(app.unit)} className="self-center text-sm text-muted-foreground">
            {uptime ? `${unitLabel(app.unit)} ${uptime}` : unitLabel(app.unit)}
          </StatusLabel>
        </div>
        <div data-app-detail className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {version && <>
            <span data-version title={version} className="inline-flex items-center gap-1.5">
              <span>{isDevelopmentVersion(version) ? baseVersion(version) : version}</span>
              <DevelopmentBadge version={version} />
            </span>
            <span aria-hidden="true">·</span>
          </>}
          <span data-host className="font-mono">{location.hostname}:{app.port}</span>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="outline" asChild><a href="#/apps">更换</a></Button>
        {/* Keep a focusable link while stopped, matching the previous behaviour. */}
        <Button asChild className={cn(!running && "pointer-events-none opacity-50")}>
          <a href={kvmURL(app.port, app.id)} aria-disabled={!running}>打开 {app.name}<ArrowUpRight aria-hidden="true" /></a>
        </Button>
      </div>
    </div>
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

function LinkFacts({ hw, power, now }: { hw: Hardware; power: Status["power"]; now: number }) {
  const h = hw.hdmi;
  const hdmiValue = h.signal ? <>{h.width}×<wbr />{h.height}</> : "无信号";
  const hdmiDetail = h.signal
    ? [`${h.refreshHz?.toFixed(2).replace(/\.?0+$/, "")} Hz`, h.colorSpace, hdrLabel(h.hdr), h.audio ? "有声音" : "无声音"]
        .filter(Boolean)
        .join(" · ")
    : "检查被控机 HDMI 输出";
  const capture = h.signal && h.captureWidth && h.captureHeight && (h.captureWidth !== h.width || h.captureHeight !== h.height)
    ? `采集 ${h.captureWidth}×${h.captureHeight}` : undefined;
  const usbConfigured = hw.usb === "configured";
  return (
    <FactGrid cols={4} className="gap-4">
      <Fact card icon={MonitorPlay} label="HDMI 输入" href="#/video" destination="视频输入" value={hdmiValue} valueKey={h.signal ? `${h.width}×${h.height}` : "无信号"}
        detail={[hdmiDetail, capture].filter(Boolean).join(" · ")} tone={h.signal ? "good" : "warning"} />
      <Fact card icon={Plug} label="USB 键鼠" href="#/services" destination="底层服务" value={usbConfigured ? "已连接" : hw.usb ? hw.usb : "未知"}
        detail={usbConfigured ? "键盘与鼠标已枚举" : "等待被控机枚举"} tone={usbConfigured ? "good" : "warning"} />
      <PowerFact power={power} kernel={hw.kernel} />
      <Fact card icon={Clock3} label="开机时长" value={duration(hw.uptimeSeconds)} detail={`开机于 ${clockTime(now - hw.uptimeSeconds * 1000, now).slice(0, -3)}`} />
    </FactGrid>
  );
}

const WINDOW_MS = 15 * 60 * 1000;

function samplingDescription(history: Sample[]): string {
  const { minutes, partial } = samplingWindow(history[0]?.t, history.at(-1)?.t);
  return partial
    ? `每 5 秒采样 · 已采样 ${minutes} 分钟，管理服务重启后重新开始`
    : "每 5 秒采样，管理服务重启后重新开始";
}

const percent = (v: number) => `${Math.round(v)}%`;

function bitrate(bps: number): string {
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} Gbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1)} Mbps`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} kbps`;
  return `${Math.round(bps)} bps`;
}

function bitrateTick(bps: number): string {
  if (bps === 0) return "0";
  return bps >= 1e9 ? `${+(bps / 1e9).toFixed(1)}G` : `${+(bps / 1e6).toFixed(1)}M`;
}

/** Rounds up to 1, 2 or 5 times a power of ten so the axis ticks stay round. */
function niceCeil(v: number): number {
  const step = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((m) => m * step).find((n) => n >= v)!;
}

function bytes(n: number): string {
  return n >= 2 ** 40 ? `${(n / 2 ** 40).toFixed(1)} TiB` : `${(n / 2 ** 30).toFixed(1)} GiB`;
}
const watts = (v: number) => `${v.toFixed(2)} W`;

function TrendCard({ title, value, detail, tone, children, icon: Icon }: {
  title: string;
  value: ReactNode;
  detail: ReactNode;
  tone?: Tone;
  children: ReactNode;
  icon: LucideIcon;
}) {
  return (
    <figure className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs">
      <figcaption className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3">
        <span data-trend-title className="text-sm font-medium">{title}</span>
        <Icon aria-hidden="true" className="size-4 self-center text-muted-foreground" />
        <span data-trend-value className="col-span-2 row-start-2 mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight tabular-nums">
          {tone && <StatusDot tone={tone} />}
          {value}
        </span>
        <span data-trend-detail className="col-span-2 mt-1 truncate text-xs text-muted-foreground" title={typeof detail === "string" ? detail : undefined}>{detail}</span>
      </figcaption>
      {children}
    </figure>
  );
}

function range(values: number[], format: (v: number) => string, period: string): string {
  if (!values.length) return "正在采样";
  return `${period} ${format(Math.min(...values))} – ${format(Math.max(...values))}`;
}

function BoardCharts({ hw, history, now }: { hw: Hardware; history: Sample[]; now: number }) {
  const [hover, setHover] = useState<number>();
  const end = Math.max(now, history.at(-1)?.t ?? 0);
  history = history.filter((s) => s.t >= end - WINDOW_MS);
  const { minutes, partial } = samplingWindow(history[0]?.t, history.at(-1)?.t);
  const period = `${partial ? "最近 " : ""}${minutes} 分钟`;
  const series = (pick: (s: Sample) => number): Point[] => history.map((s) => ({ t: s.t, v: pick(s) }));
  const cpu = series((s) => s.cpu);
  const cpuPower = history.flatMap((s) => s.cpuPowerW == null ? [] : [{ t: s.t, v: s.cpuPowerW }]);
  const lastPower = history.at(-1)?.cpuPowerW;
  const powerUnavailable = history.at(-1)?.cpuPowerAvailable === false;
  const powerMax = niceCeil(Math.max(1, ...cpuPower.map((p) => p.v)));
  const mem = series((s) => s.mem);
  const temp = series((s) => s.tempC);
  const fan = series((s) => s.fan);
  const tx = series((s) => s.txBps);
  const rx = series((s) => s.rxBps);
  const lastTx = tx.length ? tx[tx.length - 1].v : 0;
  const lastRx = rx.length ? rx[rx.length - 1].v : 0;
  const netMax = niceCeil(Math.max(1e6, ...tx.map((p) => p.v), ...rx.map((p) => p.v)));
  const shared = { end, windowMs: WINDOW_MS, hover, onHover: setHover, height: 48, sampledFrom: history[0]?.t, sampledMinutes: minutes };
  const percentageAxis = (points: Point[]) => {
    const max = Math.max(0, ...points.map((p) => p.v)) * 1.2;
    const upper = [25, 50, 100].find((v) => v >= max) ?? 100;
    return { domain: [0, upper] as [number, number], ticks: [0, upper], tickFormat: (v: number) => v === 0 ? "0" : percent(v) };
  };
  const memUsed = hw.memTotalKiB ? 1 - hw.memAvailableKiB / hw.memTotalKiB : 0;
  const lastCPU = cpu.length ? cpu[cpu.length - 1].v : undefined;
  const hottest = hw.zones.reduce<Zone | undefined>((a, z) => (!a || z.tempC > a.tempC ? z : a), undefined);
  return (
    <div data-trends className="grid grid-cols-1 gap-4 @md:grid-cols-2 @3xl:grid-cols-3">
      <TrendCard icon={Cpu} title="CPU" value={lastCPU === undefined ? "—" : percent(lastCPU)} detail={`负载 ${hw.load1.toFixed(2)} · ${range(cpu.map((p) => p.v), percent, period)}`}>
        <TrendChart label="CPU 使用率" points={cpu} {...percentageAxis(cpu)} format={percent} {...shared} />
      </TrendCard>
      <TrendCard
        icon={MemoryStick}
        title="内存"
        value={percent(memUsed * 100)}
        detail={`可用 ${(hw.memAvailableKiB / 1048576).toFixed(1)} / ${(hw.memTotalKiB / 1048576).toFixed(1)} GiB`}
        tone={memUsed > 0.9 ? "critical" : memUsed > 0.75 ? "warning" : undefined}
      >
        <TrendChart label="内存占用" points={mem} {...percentageAxis(mem)} format={percent} {...shared} />
      </TrendCard>
      <TrendCard icon={Network} title="网络" value={<><small className="text-xs font-normal text-muted-foreground">发送</small>{bitrate(lastTx)}</>} detail={
        <span data-legend className="inline-flex flex-wrap items-center gap-1.5">
          <span aria-hidden="true" className="h-0.5 w-3 rounded-full bg-chart-1" />发送（主要是视频）
          <span aria-hidden="true" className="ml-2 h-0.5 w-3 rounded-full bg-chart-2" />接收 {bitrate(lastRx)}
        </span>
      }>
        <TrendChart label="网络发送" points={tx} compare={{ label: "接收", points: rx }}
          domain={[0, netMax]} ticks={[0, netMax]} format={bitrate} tickFormat={bitrateTick} {...shared} />
      </TrendCard>
      <TrendCard icon={Zap} title="CPU 动态功耗（估算）" value={lastPower == null ? "—" : watts(lastPower)}
        detail={powerUnavailable ? "功耗模型或计数器不可用" : lastPower == null ? "需要连续两次有效采样" : "按频率驻留与各核利用率估算 · 不含静态功耗"}>
        <TrendChart label="CPU 动态功耗估算" points={cpuPower} domain={[0, powerMax]}
          ticks={[0, powerMax]} format={watts} maxGapMs={7500}
          currentAvailable={lastPower != null} emptyMessage={powerUnavailable ? "暂无法估算" : "正在采样…"} {...shared} />
      </TrendCard>
      <TrendCard
        icon={Thermometer}
        title="SoC 温度"
        value={celsius(hw.tempC)}
        detail={hottest && hottest.name !== "soc" ? `最高 ${hottest.name.toUpperCase()} ${celsius(hottest.tempC)}` : range(temp.map((p) => p.v), celsius, period)}
        tone={tempTone(hw.tempC)}
      >
        {(() => {
          const domain = tempDomain(temp.map((p) => p.v));
          const ticks = [domain[0], domain[1]];
          return <TrendChart label="SoC 温度" points={temp} domain={domain} ticks={ticks} format={celsius} {...shared} />;
        })()}
      </TrendCard>
      <TrendCard
        icon={Fan}
        title="风扇"
        value={hw.fanPercent > 0 ? `${hw.fanPercent}%` : "停转"}
        detail={hw.fanAuto ? "自动 · 占空比" : "手动 · 占空比"}
      >
        <TrendChart label="风扇占空比" points={fan} {...percentageAxis(fan)} format={percent} {...shared} />
      </TrendCard>
    </div>
  );
}

const linkButton = "self-start rounded-sm text-xs text-primary outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

function EventList({ events, now }: { events: BoardEvent[]; now: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? events : events.slice(0, 5);
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
  return (
    <ul className="flex flex-col divide-y">
      {links.map((l) => (
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
    </ul>
  );
}

const meterTones: Record<Tone, string> = { good: "bg-success", warning: "bg-warning", critical: "bg-destructive-fill", idle: "bg-idle" };

function Meter({ fraction, tone }: { fraction: number; tone: Tone }) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <span role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="block h-1.5 overflow-hidden rounded-full bg-muted">
      <span className={cn("block h-full rounded-full", meterTones[tone])} style={{ width: `${pct}%` }} />
    </span>
  );
}

function StorageAndVersions({ system }: { system: System }) {
  const { totalBytes, freeBytes } = system.disk;
  const used = totalBytes ? 1 - freeBytes / totalBytes : 0;
  const [open, setOpen] = useState(false);
  const versions = new Set(system.packages.map((p) => p.version));
  return (
    <dl className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <dt className="text-xs text-muted-foreground">系统盘</dt>
        <dd className="flex flex-col gap-1.5">
          <span className="text-sm tabular-nums">已用 {bytes(totalBytes - freeBytes)} / {bytes(totalBytes)}</span>
          <Meter fraction={used} tone={used > 0.9 ? "critical" : used > 0.8 ? "warning" : "good"} />
          <span className="text-xs text-muted-foreground">剩余 {bytes(freeBytes)}，虚拟介质镜像也存在这里。</span>
        </dd>
      </div>
      <div className="flex flex-col gap-1.5">
        <dt className="text-xs text-muted-foreground">组件版本</dt>
        <dd className="flex flex-col gap-1.5">
          <span className="inline-flex flex-wrap items-center gap-1.5 text-sm tabular-nums [overflow-wrap:anywhere]">
            {system.packages.length ? (versions.size === 1 ? [...versions][0] : `${system.packages.length} 个组件，${versions.size} 个版本`) : "—"}
            {versions.size === 1 && <DevelopmentBadge version={[...versions][0]} />}
          </span>
          {system.packages.length > 0 && (
            <button type="button" className={linkButton} aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? "收起" : "查看各组件"}
            </button>
          )}
          <Collapse open={open}>
            <ul className="flex flex-col divide-y text-xs">
              {system.packages.map((p) => (
                <li key={p.name} className="flex justify-between gap-3 py-1.5">
                  <span>{p.name}</span>
                  <span className="inline-flex items-center gap-1.5 text-secondary-foreground"><span className="font-mono text-[11px]">{p.version}</span><DevelopmentBadge version={p.version} /></span>
                </li>
              ))}
            </ul>
          </Collapse>
        </dd>
      </div>
    </dl>
  );
}

/** Same shape as the loaded overview; the text stays for screen readers. */
function OverviewSkeleton() {
  return (
    <div className="@container flex flex-col gap-4" aria-busy="true">
      <span className="sr-only">正在读取…</span>
      <Skeleton className="h-20 rounded-xl" />
      <div className="grid grid-cols-1 gap-4 @md:grid-cols-2 @4xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
      </div>
      <div className="grid grid-cols-1 gap-4 @md:grid-cols-2 @3xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-48 rounded-xl" />)}
      </div>
    </div>
  );
}

export function Overview() {
  const { status, now } = useStatusStore(useShallow((s) => ({ status: s.status, now: s.now })));
  if (!status) return <OverviewSkeleton />;
  const hw = status.hardware;
  return (
    <FadeIn className="@container flex flex-col gap-4">
      <SettingsCard label="当前状态">
        <ActiveApp status={status} now={now} />
      </SettingsCard>
      <LinkFacts hw={hw} power={status.power} now={now} />
      <section aria-labelledby="resource-trends" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="resource-trends" className="text-base font-semibold tracking-tight">最近 15 分钟</h2>
          <p className="text-xs text-muted-foreground">{samplingDescription(status.history)}</p>
        </div>
        <BoardCharts hw={hw} history={status.history} now={now} />
      </section>
      <div className="grid grid-cols-1 items-start gap-4 @3xl:grid-cols-2">
        <SettingsCard title="最近事件" description="信号、USB、服务与操作记录，管理服务重启后清空。">
          <EventList events={status.events} now={now} />
        </SettingsCard>
        <div className="grid grid-cols-1 gap-4">
          <SettingsCard title="网络">
            <NetworkList links={status.system.links} />
          </SettingsCard>
          <SettingsCard title="存储与版本">
            <StorageAndVersions system={status.system} />
          </SettingsCard>
        </div>
      </div>
    </FadeIn>
  );
}


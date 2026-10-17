import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { TailscalePanel } from "./TailscalePanel";
import { WifiControl } from "./WifiControl";
import { EDIDPanel } from "./EDIDPanel";
import {
  getStatus,
  previewHDRCurve,
  restartUnit,
  selectApp,
  setFanCurve,
  setHDRCurve,
  type App as KvmApp,
  type Hardware,
  type Platform,
  type BoardEvent,
  type Link,
  type Sample,
  type System,
  type Zone,
  type Status,
  type Unit,
} from "./api";
import { HDRPanel } from "./HDRPanel";
import { TrendChart, tempDomain, type Point } from "./Charts";
import { FanPanel } from "./FanPanel";
import { UpdatesPanel } from "./UpdatesPanel";
import { MediaPanel, MediaSummary, MediaWait, needsMediaEject } from "./MediaPanel";
import { DiskPanel } from "./DiskPanel";
import { DevelopmentTag } from "./DevelopmentTag";

const POLL_MS = 3000;

type Tone = "good" | "warning" | "critical" | "idle";

function unitTone(unit: Unit): Tone {
  if (!unit.loaded) return "idle";
  if (unit.active === "active") return "good";
  if (unit.active === "failed") return "critical";
  if (unit.active === "activating" || unit.active === "deactivating" || unit.active === "reloading") return "warning";
  return "idle";
}

function unitLabel(unit: Unit): string {
  if (!unit.loaded) return "未安装";
  switch (unit.active) {
    case "active":
      // Oneshot board units stay "active (exited)" after doing their work.
      return unit.sub === "exited" ? "已完成" : "运行中";
    case "failed":
      return "失败";
    case "activating":
      return "启动中";
    case "deactivating":
      return "停止中";
    default:
      return "已停止";
  }
}

function duration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分钟`;
}

function since(unit: Unit, now: number): string | undefined {
  if (!unit.since || unit.active !== "active") return undefined;
  return duration(Math.max(0, (now - Date.parse(unit.since)) / 1000));
}

// hdmi_hdr_status values: "SDR", "HDR10-GAMMA_ST2084", "HDR10-GAMMA_HLG", "HDR10Plus-VSIF", ...
function hdrLabel(status?: string): string | undefined {
  if (!status) return undefined;
  if (status === "SDR") return "SDR";
  if (status.includes("HLG")) return "HLG";
  if (status.includes("Plus")) return "HDR10+";
  if (status.startsWith("HDR")) return "HDR10";
  return status;
}

function kvmURL(port: number, app: string): string {
  return `${location.protocol}//${location.hostname}:${port}/?kvm=${encodeURIComponent(app)}`;
}

function StatusDot({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className={`status status-${tone}`}>
      <span className="lamp" aria-hidden="true" />
      {label}
    </span>
  );
}

function AppRow({
  app,
  selected,
  busy,
  confirming,
  mediaBlocked,
  onChoose,
  onConfirm,
  onCancel,
  onRestart,
  now,
}: {
  app: KvmApp;
  selected: boolean;
  busy: boolean;
  confirming: boolean;
  mediaBlocked: boolean;
  onChoose: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onRestart: () => void;
  now: number;
}) {
  const installed = app.unit.loaded;
  const running = app.unit.active === "active";
  return (
    <li className={`app-row${selected ? " is-selected" : ""}${installed ? "" : " is-missing"}`}>
      <div className="app-name">
        <h3>
          {app.name}
          {selected && <span className="tag">开机启用</span>}
        </h3>
        <p>{app.description}</p>
      </div>
      <div className="app-state">
        <StatusDot tone={unitTone(app.unit)} label={unitLabel(app.unit)} />
        <span className="num muted">{since(app.unit, now) ?? ""}</span>
      </div>
      <div className="app-actions">
        {!installed ? (
          <span className="muted">未安装</span>
        ) : selected ? (
          <>
            <button className="button" onClick={onRestart} disabled={busy}>
              重启
            </button>
            <a className={`button primary${running ? "" : " is-disabled"}`} href={kvmURL(app.port, app.id)} aria-disabled={!running}>
              打开
            </a>
          </>
        ) : (
          <button className="button" onClick={onChoose} disabled={busy || confirming}>
            切换到此
          </button>
        )}
      </div>
      {confirming && (
        <div className="confirm" role="alertdialog" aria-label={`切换到 ${app.name}`}>
          <span>{mediaBlocked ? "虚拟磁盘仍已挂载。先在被控电脑安全弹出，检测到弹出后再切换。" : "当前远程会话会断开。"}</span>
          <button className="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button className="button primary" onClick={onConfirm} disabled={busy}>
            {mediaBlocked ? "弹出后继续切换" : `切换到 ${app.name}`}
          </button>
        </div>
      )}
    </li>
  );
}

function Readout({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: Tone }) {
  return (
    <div className="readout">
      <dt>{label}</dt>
      <dd>
        <span className="readout-value">
          {tone && <span className={`lamp status-${tone}`} aria-hidden="true" />}
          {value}
        </span>
        {detail && <span className="readout-detail">{detail}</span>}
      </dd>
    </div>
  );
}

function tempTone(c: number): Tone {
  return c >= 85 ? "critical" : c >= 70 ? "warning" : "good";
}

function PowerSummary({ power }: { power: Status["power"] }) {
  const contract = power?.bootContract;
  return (
    <Section title="供电" description="USB-C 检测到电压不代表它是整板唯一的供电来源。">
      <dl className="readouts">
        <Readout label="USB-C 电压状态"
          value={power?.vbusPresent === true ? "检测到电压" : power?.vbusPresent === false ? "未检测到电压" : "未知"}
          detail="电压存在检测，不是电压测量值" />
        <Readout label="本次开机 PD 协商"
          value={contract ? `${contract.voltageV} V / ${contract.currentA} A` : "暂无记录"}
          detail={contract ? `供电额度 ${contract.voltageV * contract.currentA} W · 运行期间可能变化` : "尚无可确认的协商结果"} />
        <Readout label="实时功耗" value="不可用" detail="当前没有电流与功率测量数据" />
      </dl>
    </Section>
  );
}

function LinkTiles({ hw }: { hw: Hardware }) {
  const h = hw.hdmi;
  const hdmiValue = h.signal ? `${h.width}×${h.height}` : "无信号";
  const hdmiDetail = h.signal
    ? [`${h.refreshHz?.toFixed(2).replace(/\.?0+$/, "")} Hz`, h.colorSpace, hdrLabel(h.hdr), h.audio ? "有声音" : "无声音"]
        .filter(Boolean)
        .join(" · ")
    : "检查被控机 HDMI 输出";
  const capture = h.captureWidth ? `采集 ${h.captureWidth}×${h.captureHeight}` : undefined;
  const usbConfigured = hw.usb === "configured";
  return (
    <dl className="readouts">
      <Readout label="HDMI 输入" value={hdmiValue} detail={[hdmiDetail, capture].filter(Boolean).join(" · ")} tone={h.signal ? "good" : "warning"} />
      <Readout
        label="USB 键鼠"
        value={usbConfigured ? "已连接" : hw.usb ? hw.usb : "未知"}
        detail={usbConfigured ? "键盘与鼠标已枚举" : "等待被控机枚举"}
        tone={usbConfigured ? "good" : "warning"}
      />
      <Readout label="开机时长" value={duration(hw.uptimeSeconds)} detail={`负载 ${hw.load1.toFixed(2)} · ${hw.cpus} 核`} />
    </dl>
  );
}

const WINDOW_MS = 15 * 60 * 1000;

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
const celsius = (v: number) => `${v.toFixed(1)} °C`;

function TrendCard({
  title,
  value,
  detail,
  tone,
  wide,
  children,
}: {
  title: string;
  value: string;
  detail: ReactNode;
  tone?: Tone;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <figure className={`trend${wide ? " trend-wide" : ""}`}>
      <figcaption>
        <span className="trend-title">{title}</span>
        <span className="trend-value">
          {tone && <span className={`lamp status-${tone}`} aria-hidden="true" />}
          {value}
        </span>
        <span className="trend-detail">{detail}</span>
      </figcaption>
      {children}
    </figure>
  );
}

function range(values: number[], format: (v: number) => string): string {
  if (!values.length) return "正在采样";
  return `15 分钟 ${format(Math.min(...values))} – ${format(Math.max(...values))}`;
}

function BoardCharts({ hw, history, now }: { hw: Hardware; history: Sample[]; now: number }) {
  const [hover, setHover] = useState<number>();
  const series = (pick: (s: Sample) => number): Point[] => history.map((s) => ({ t: s.t, v: pick(s) }));
  const cpu = series((s) => s.cpu);
  const mem = series((s) => s.mem);
  const temp = series((s) => s.tempC);
  const fan = series((s) => s.fan);
  const tx = series((s) => s.txBps);
  const rx = series((s) => s.rxBps);
  const lastTx = tx.length ? tx[tx.length - 1].v : 0;
  const lastRx = rx.length ? rx[rx.length - 1].v : 0;
  const netMax = niceCeil(Math.max(1e6, ...tx.map((p) => p.v), ...rx.map((p) => p.v)));
  const end = Math.max(now, history.length ? history[history.length - 1].t : 0);
  const shared = { end, windowMs: WINDOW_MS, hover, onHover: setHover };
  const memUsed = hw.memTotalKiB ? 1 - hw.memAvailableKiB / hw.memTotalKiB : 0;
  const lastCPU = cpu.length ? cpu[cpu.length - 1].v : undefined;
  const hottest = hw.zones.reduce<Zone | undefined>((a, z) => (!a || z.tempC > a.tempC ? z : a), undefined);
  return (
    <div className="trends">
      <TrendCard title="CPU" value={lastCPU === undefined ? "—" : percent(lastCPU)} detail={`负载 ${hw.load1.toFixed(2)} · ${range(cpu.map((p) => p.v), percent)}`}>
        <TrendChart label="CPU 使用率" points={cpu} domain={[0, 100]} ticks={[0, 50, 100]} format={percent} {...shared} />
      </TrendCard>
      <TrendCard
        title="内存"
        value={percent(memUsed * 100)}
        detail={`可用 ${(hw.memAvailableKiB / 1048576).toFixed(1)} / ${(hw.memTotalKiB / 1048576).toFixed(1)} GiB`}
        tone={memUsed > 0.9 ? "critical" : memUsed > 0.75 ? "warning" : undefined}
      >
        <TrendChart label="内存占用" points={mem} domain={[0, 100]} ticks={[0, 50, 100]} format={percent} {...shared} />
      </TrendCard>
      <TrendCard
        title="SoC 温度"
        value={celsius(hw.tempC)}
        detail={hottest && hottest.name !== "soc" ? `最高 ${hottest.name.toUpperCase()} ${celsius(hottest.tempC)}` : range(temp.map((p) => p.v), celsius)}
        tone={tempTone(hw.tempC)}
      >
        {(() => {
          const domain = tempDomain(temp.map((p) => p.v));
          const ticks = [domain[0], (domain[0] + domain[1]) / 2, domain[1]];
          return <TrendChart label="SoC 温度" points={temp} domain={domain} ticks={ticks} format={celsius} {...shared} />;
        })()}
      </TrendCard>
      <TrendCard
        title="风扇"
        value={hw.fanPercent > 0 ? `${hw.fanPercent}%` : "停转"}
        detail={hw.fanAuto ? "自动 · 占空比" : "手动 · 占空比"}
      >
        <TrendChart label="风扇占空比" points={fan} domain={[0, 100]} ticks={[0, 50, 100]} format={percent} {...shared} />
      </TrendCard>
      <TrendCard
        title="网络吞吐"
        value={bitrate(lastTx)}
        detail={
          <span className="legend">
            <span className="legend-key" />
            发送（主要是视频）
            <span className="legend-key legend-key-muted" />
            接收 {bitrate(lastRx)}
          </span>
        }
        wide
      >
        <TrendChart
          label="网络发送"
          points={tx}
          compare={{ label: "接收", points: rx }}
          domain={[0, netMax]}
          ticks={[0, netMax / 2, netMax]}
          format={bitrate}
          tickFormat={bitrateTick}
          {...shared}
        />
      </TrendCard>
    </div>
  );
}

function NetworkList({ links }: { links: Link[] }) {
  if (!links.length) return <p className="hint">没有检测到网卡。</p>;
  return (
    <table className="table">
      <tbody>
        {links.map((l) => (
          <tr key={l.name}>
            <td className="cell-key">
              <StatusDot tone={l.up ? "good" : "idle"} label={l.wireless ? `Wi-Fi ${l.name}` : l.name === "usb0" ? "USB 网卡" : `有线 ${l.name}`} />
            </td>
            <td className="num nowrap muted">{l.up ? (l.speedMbps ? (l.speedMbps >= 1000 ? `${l.speedMbps / 1000} Gbps` : `${l.speedMbps} Mbps`) : "已连接") : "未连接"}</td>
            <td>
              <div className="addr-cell">
                <Addresses addrs={l.addrs ?? []} />
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Addresses({ addrs }: { addrs: string[] }) {
  const v4 = addrs.filter((a) => !a.includes(":"));
  const v6 = addrs.filter((a) => a.includes(":"));
  if (!addrs.length) return <span className="muted">—</span>;
  return (
    <>
      {v4.map((a) => (
        <span key={a} className="mono">
          {a}
        </span>
      ))}
      {v6.length > 0 && (
        <span className="muted addr-v6" title={v6.join("\n")}>
          {v4.length ? `+ ${v6.length} 个 IPv6` : v6[0]}
        </span>
      )}
    </>
  );
}

function StorageAndVersions({ system }: { system: System }) {
  const { totalBytes, freeBytes } = system.disk;
  const used = totalBytes ? 1 - freeBytes / totalBytes : 0;
  const [open, setOpen] = useState(false);
  const versions = new Set(system.packages.map((p) => p.version));
  return (
    <dl className="facts">
      <div>
        <dt>系统盘</dt>
        <dd>
          <span className="num">
            已用 {bytes(totalBytes - freeBytes)} / {bytes(totalBytes)}
          </span>
          <Meter fraction={used} tone={used > 0.9 ? "critical" : used > 0.8 ? "warning" : "good"} />
          <span className="muted">剩余 {bytes(freeBytes)}，虚拟介质镜像也存在这里。</span>
        </dd>
      </div>
      <div>
        <dt>组件版本</dt>
        <dd>
          <span className="num package-version">
            {system.packages.length ? (versions.size === 1 ? [...versions][0] : `${system.packages.length} 个组件，${versions.size} 个版本`) : "—"}
            {versions.size === 1 && <DevelopmentTag version={[...versions][0]} />}
          </span>
          {system.packages.length > 0 && (
            <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? "收起" : "查看各组件"}
            </button>
          )}
          {open && (
            <ul className="packages">
              {system.packages.map((p) => (
                <li key={p.name}>
                  <span>{p.name}</span>
                  <span className="package-version"><span className="mono">{p.version}</span><DevelopmentTag version={p.version} /></span>
                </li>
              ))}
            </ul>
          )}
        </dd>
      </div>
    </dl>
  );
}

function clockTime(t: number, now: number): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

function EventList({ events, now }: { events: BoardEvent[]; now: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? events : events.slice(0, 8);
  return (
    <>
      <ol className="events">
        {shown.map((e) => (
          <li key={`${e.t}-${e.text}`} className={`event event-${e.tone}`}>
            <time className="num" dateTime={new Date(e.t).toISOString()}>
              {clockTime(e.t, now)}
            </time>
            <span className="lamp" aria-hidden="true" />
            <span>{e.text}</span>
          </li>
        ))}
      </ol>
      {events.length > shown.length && (
        <button type="button" className="link" onClick={() => setAll(true)}>
          显示全部 {events.length} 条
        </button>
      )}
    </>
  );
}

function Thermal({ hw, busy, run }: { hw: Hardware; busy: boolean; run: Run }) {
  return (
    <>
      {hw.fanTriggers ? (
        <Section title="风扇曲线" description="拖动曲线上的三个温度点，或选一个预设。应用后立即生效，重启后保留。">
          <FanPanel
            saved={hw.fanTriggers}
            auto={hw.fanAuto}
            tempC={hw.tempC}
            percent={hw.fanPercent}
            busy={busy}
            onApply={async (t) => {
              await run("正在应用风扇曲线…", () => setFanCurve(t), `风扇曲线已应用：${t.low} / ${t.mid} / ${t.high} °C`);
            }}
          />
        </Section>
      ) : (
        <p className="hint">未检测到 MCU 风扇控制接口。</p>
      )}
      <Section title="各区温度">
        <ul className="zones">
          {hw.zones.map((z) => (
            <li key={z.name}>
              <span className="zone-name">{z.name.toUpperCase()}</span>
              <Meter fraction={z.tempC / 100} tone={tempTone(z.tempC)} />
              <span className="zone-value num">{celsius(z.tempC)}</span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function Meter({ fraction, tone }: { fraction: number; tone: Tone }) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <span className={`meter meter-${tone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

function PlatformList({
  services,
  busy,
  onRestart,
  now,
}: {
  services: Platform[];
  busy: boolean;
  onRestart: (unit: string, name: string) => void;
  now: number;
}) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>服务</th>
          <th>状态</th>
          <th className="hide-narrow">已运行</th>
          <th aria-label="操作" />
        </tr>
      </thead>
      <tbody>
        {services.map((p) => (
          <tr key={p.unit.name}>
            <td>
              <span className="cell-title">{p.name}</span>
              <span className="mono muted">{p.unit.name}</span>
            </td>
            <td>
              <StatusDot tone={unitTone(p.unit)} label={unitLabel(p.unit)} />
            </td>
            <td className="num muted hide-narrow">{since(p.unit, now) ?? "—"}</td>
            <td className="cell-action">
              {p.restartable && (
                <button className="button small" disabled={busy || !p.unit.loaded} onClick={() => onRestart(p.unit.name, p.name)}>
                  重启
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type Run = (label: string, action: () => Promise<unknown>, done: string) => Promise<boolean>;

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <h3>{title}</h3>
        {description && <p className="muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

type PageId = "overview" | "apps" | "media" | "disks" | "video" | "cooling" | "network" | "services" | "updates";

const ICONS: Record<PageId, ReactNode> = {
  overview: <path d="M4 13h6V4H4zm0 7h6v-5H4zm10 0h6v-9h-6zm0-16v5h6V4z" />,
  apps: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M9 20h6M12 16v4" />
    </>
  ),
  media: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.2" />
    </>
  ),
  disks: (
    <>
      <path d="M7 3h7l3 3v15H7z" />
      <path d="M10 3v4h4M10 12h4M10 16h4" />
    </>
  ),
  video: (
    <>
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="m16 10 5-3v10l-5-3" />
    </>
  ),
  cooling: (
    <>
      <circle cx="12" cy="12" r="2" />
      <path d="M12 10c0-4 1-6 4-6 2 0 3 2 1 4l-3 3M14 12c4 0 6 1 6 4 0 2-2 3-4 1l-3-3M12 14c0 4-1 6-4 6-2 0-3-2-1-4l3-3M10 12c-4 0-6-1-6-4 0-2 2-3 4-1l3 3" />
    </>
  ),
  network: <path d="M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5h.01" />,
  services: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" />
    </>
  ),
  updates: <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" />,
};

const PAGES: { id: PageId; title: string; description?: string }[] = [
  { id: "overview", title: "概览" },
  { id: "apps", title: "KVM 界面", description: "四个界面共用采集、编码器和键鼠，同一时间只运行一个。" },
  { id: "media", title: "虚拟介质", description: "挂载到被控电脑的 U 盘或光盘。四个界面共用同一个 USB 存储设备，切换界面不会改变已挂载的介质。" },
  { id: "disks", title: "数据盘", description: "在板子上创建 U 盘镜像，上传或取回文件，挂载后被控电脑当作普通 U 盘使用。" },
  { id: "video", title: "视频输入" },
  { id: "cooling", title: "散热" },
  { id: "network", title: "网络" },
  { id: "services", title: "底层服务", description: "重启 HDMI 采集会先暂停当前界面，完成后自动恢复。" },
  { id: "updates", title: "更新" },
];

function pageFromHash(): PageId {
  const id = location.hash.replace(/^#\/?/, "");
  return PAGES.some((p) => p.id === id) ? (id as PageId) : "overview";
}

function usePage() {
  const [page, setPage] = useState(pageFromHash);
  useEffect(() => {
    const change = () => setPage(pageFromHash());
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  return page;
}

function navHint(id: PageId, status: Status): { text: string; tone?: Tone } | undefined {
  const hw = status.hardware;
  switch (id) {
    case "apps": {
      const app = status.apps.find((a) => a.id === status.active);
      return app ? { text: app.name, tone: unitTone(app.unit) } : { text: "未启用", tone: "warning" };
    }
    case "media":
      if (!status.media?.known) return { text: "未知", tone: "warning" };
      return status.media.inserted ? { text: status.media.cdrom ? "光盘" : "磁盘", tone: status.media.connected ? "good" : "warning" } : undefined;
    case "video":
      return hw.hdmi.signal ? { text: `${hw.hdmi.height}p`, tone: "good" } : { text: "无信号", tone: "warning" };
    case "cooling":
      return { text: `${Math.round(hw.tempC)}°`, tone: tempTone(hw.tempC) };
    case "services": {
      const failed = status.platform.filter((p) => p.unit.active === "failed").length;
      return failed ? { text: `${failed} 失败`, tone: "critical" } : undefined;
    }
  }
  return undefined;
}

function Sidebar({ page, status, stale }: { page: PageId; status?: Status; stale: boolean }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">VIM4</span>
        <span className="brand-name">KVM</span>
      </div>
      <nav aria-label="页面">
        {PAGES.map((p) => {
          const hint = status && navHint(p.id, status);
          return (
            <a key={p.id} href={`#/${p.id}`} className="nav-item" aria-current={page === p.id ? "page" : undefined}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                {ICONS[p.id]}
              </svg>
              <span className="nav-label">{p.title}</span>
              {hint && (
                <span className={`nav-hint${hint.tone && hint.tone !== "good" ? ` status-${hint.tone}` : ""}`}>{hint.text}</span>
              )}
            </a>
          );
        })}
      </nav>
      <div className="sidebar-foot">
        <StatusDot tone={stale ? "critical" : status ? "good" : "warning"} label={stale ? "连接中断" : status ? status.hardware.hostname : "连接中"} />
        {status && <span className="mono">{status.hardware.kernel}</span>}
      </div>
    </aside>
  );
}

function ActiveApp({ status, now }: { status: Status; now: number }) {
  const app = status.apps.find((a) => a.id === status.active);
  if (!app) {
    return (
      <div className="lead">
        <span className="muted">还没有启用 KVM 界面。</span>
        <a className="button primary" href="#/apps">
          选择界面
        </a>
      </div>
    );
  }
  const running = app.unit.active === "active";
  const uptime = since(app.unit, now);
  return (
    <div className="lead">
      <div className="lead-title">
        <h3>{app.name}</h3>
        <StatusDot tone={unitTone(app.unit)} label={uptime ? `${unitLabel(app.unit)} ${uptime}` : unitLabel(app.unit)} />
      </div>
      <a className="button" href="#/apps">
        更换
      </a>
      <a className={`button primary${running ? "" : " is-disabled"}`} href={kvmURL(app.port, app.id)} aria-disabled={!running}>
        打开 {app.name}
      </a>
    </div>
  );
}

export function App() {
  const page = usePage();
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const [waiting, setWaiting] = useState<{ app: KvmApp; source: string; started: number }>();
  const waitingRef = useRef(false);
  const [notice, setNotice] = useState<{ tone: Tone; text: string }>();
  const [now, setNow] = useState(Date.now());
  const timer = useRef<number>(undefined);
  const main = useRef<HTMLElement>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getStatus());
      setStale(false);
      setNow(Date.now());
    } catch {
      setStale(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    timer.current = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer.current);
  }, [refresh]);

  useEffect(() => {
    setConfirming(undefined);
    window.scrollTo(0, 0);
    main.current?.focus({ preventScroll: true });
  }, [page]);

  const run: Run = async (label, action, done) => {
    setBusy(label);
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
      setNotice({ tone: "good", text: done });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(undefined);
      setConfirming(undefined);
      refresh();
    }
  };

  const cancelWaiting = () => {
    waitingRef.current = false;
    setWaiting(undefined);
  };
  const switchApp = (app: KvmApp) => {
    cancelWaiting();
    return run(`正在切换到 ${app.name}…`, () => selectApp(app.id), `已切换到 ${app.name}`);
  };
  useEffect(() => {
    if (!waiting || !waitingRef.current) return;
    if (page !== "apps" || stale || !status?.media?.known || status.active !== waiting.source
      || Date.now() - waiting.started >= 300_000) {
      cancelWaiting();
      setNotice({ tone: "warning", text: "已取消等待切换，请确认当前状态后重新选择。" });
      return;
    }
    if (!status.media.inserted) {
      // Clear the ref synchronously: repeated renders/StrictMode must not
      // submit the same switch twice. The root helper rechecks the LUN.
      void switchApp(waiting.app);
    }
  }, [waiting, status, stale, page]);

  const meta = PAGES.find((p) => p.id === page)!;
  const hw = status?.hardware;

  return (
    <div className="layout">
      <Sidebar page={page} status={status} stale={stale} />
      <main ref={main} tabIndex={-1} aria-labelledby="page-title">
        <header className="page-head">
          <h2 id="page-title">{meta.title}</h2>
          {meta.description && <p>{meta.description}</p>}
        </header>

        {(error || notice || busy) && (
          <div className={`banner banner-${error ? "critical" : busy ? "warning" : notice?.tone}`} role="status">
            {busy ? <span className="spinner" aria-hidden="true" /> : <span className="lamp" aria-hidden="true" />}
            <span>{error ?? busy ?? notice?.text}</span>
            {!busy && (
              <button className="banner-close" aria-label="关闭" onClick={() => (setError(undefined), setNotice(undefined))}>
                ×
              </button>
            )}
          </div>
        )}

        <div className="page-body" key={page}>
        {page === "network" && (
          <>
            <WifiControl busy={!!busy} />
            <TailscalePanel busy={!!busy} />
          </>
        )}
        {page === "updates" && <UpdatesPanel busy={!!busy} run={run} active={status?.active} />}
        {page === "video" && (
          <Section title="EDID" description="被控电脑看到的显示器型号与能力。">
            <EDIDPanel busy={!!busy} run={run} />
          </Section>
        )}

        {!status ? (
          page !== "network" && page !== "video" && page !== "updates" && <div className="skeleton" />
        ) : (
          <>
            {page === "overview" && hw && (
              <>
                <ActiveApp status={status} now={now} />
                <LinkTiles hw={hw} />
                <PowerSummary power={status.power} />
                <Section title="最近 15 分钟" description="每 5 秒采样，管理服务重启后重新开始。">
                  <BoardCharts hw={hw} history={status.history} now={now} />
                </Section>
                <div className="overview-columns">
                  <Section title="最近事件" description="信号、USB、服务与操作记录，管理服务重启后清空。">
                    <EventList events={status.events} now={now} />
                  </Section>
                  <div className="overview-side">
                    <Section title="网络">
                      <NetworkList links={status.system.links} />
                    </Section>
                    <Section title="存储与版本">
                      <StorageAndVersions system={status.system} />
                    </Section>
                  </div>
                </div>
              </>
            )}

            {page === "apps" && (
              <>
                {waiting ? (
                  <MediaWait media={status.media} target={waiting.app.name} onCancel={cancelWaiting} />
                ) : (
                  <MediaSummary media={stale ? undefined : status.media} />
                )}
                <ul className="apps">
                  {status.apps.map((app) => (
                    <AppRow
                      key={app.id}
                      app={app}
                      now={now}
                      selected={app.id === status.active}
                      busy={!!busy || !!waiting || stale || !status.media?.known}
                      confirming={confirming === app.id}
                      mediaBlocked={needsMediaEject(status.media, app.id)}
                      onChoose={() => setConfirming(app.id)}
                      onCancel={() => setConfirming(undefined)}
                      onConfirm={() => {
                        if (needsMediaEject(status.media, app.id)) {
                          waitingRef.current = true;
                          setWaiting({ app, source: status.active, started: Date.now() });
                          setConfirming(undefined);
                          setError(undefined);
                          setNotice(undefined);
                        } else void switchApp(app);
                      }}
                      onRestart={() => run(`正在重启 ${app.name}…`, () => restartUnit(app.unit.name), `${app.name} 已重启`)}
                    />
                  ))}
                </ul>
                {!status.apps.some((a) => a.id === status.active) && <p className="hint">尚未启用任何界面，选择一个即可开机自动启动。</p>}
              </>
            )}

            {page === "media" && (
              <MediaPanel
                media={stale ? undefined : status.media}
                active={status.active}
                activeName={status.apps.find((a) => a.id === status.active)?.name}
                busy={!!busy}
                run={run}
              />
            )}

            {page === "disks" && (
              <DiskPanel
                busy={!!busy}
                run={run}
                report={(tone, text) => (tone === "critical" ? (setNotice(undefined), setError(text)) : (setError(undefined), setNotice({ tone, text })))}
                mediaToken={stale ? undefined : `${status.media?.token ?? ""}:${status.media?.readOnly}`}
              />
            )}

            {page === "video" && hw && (
              <Section
                title="HDR 转 SDR"
                description="被控机输出 HDR 时按此曲线映射为 SDR。画面偏暗就提高桌面亮度，高光发白就扩大高光范围。"
              >
                <HDRPanel
                  curve={hw.hdrCurve}
                  hdr={hw.hdmi.hdr}
                  busy={!!busy}
                  onPreview={previewHDRCurve}
                  onSave={(curve) =>
                    run("正在保存 HDR 映射…", () => setHDRCurve(curve), `HDR 映射已保存：SDR 白 ${curve.white} 尼特，高光保留到 ${curve.peak} 尼特`)
                  }
                />
              </Section>
            )}

            {page === "cooling" && hw && <Thermal hw={hw} busy={!!busy} run={run} />}

            {page === "services" && (
              <PlatformList
                services={status.platform}
                busy={!!busy}
                now={now}
                onRestart={(unit, name) => run(`正在重启${name}…`, () => restartUnit(unit), `${name}已重启`)}
              />
            )}
          </>
        )}
        </div>
      </main>
    </div>
  );
}

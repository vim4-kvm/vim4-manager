import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { WifiControl } from "./WifiControl";
import { EDIDPanel } from "./EDIDPanel";
import {
  getStatus,
  previewHDRCurve,
  restartUnit,
  selectApp,
  setHDRCurve,
  type App as KvmApp,
  type Hardware,
  type Platform,
  type Sample,
  type Zone,
  type Status,
  type Unit,
} from "./api";
import { HDRPanel } from "./HDRPanel";
import { FanCurveChart, TrendChart, tempDomain, type Point } from "./Charts";

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
      <span className="status-icon" aria-hidden="true">
        {tone === "good" ? "✓" : tone === "critical" ? "!" : tone === "warning" ? "…" : "–"}
      </span>
      {label}
    </span>
  );
}

function AppCard({
  app,
  selected,
  busy,
  confirming,
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
  onChoose: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onRestart: () => void;
  now: number;
}) {
  const installed = app.unit.loaded;
  const running = app.unit.active === "active";
  const uptime = since(app.unit, now);
  return (
    <article className={`app-card${selected ? " is-selected" : ""}${installed ? "" : " is-missing"}`}>
      <header className="app-card-head">
        <div>
          <h3>{app.name}</h3>
          <p className="muted">{app.description}</p>
        </div>
        {selected && <span className="badge">当前启用</span>}
      </header>
      <dl className="app-meta">
        <div>
          <dt>状态</dt>
          <dd>
            <StatusDot tone={unitTone(app.unit)} label={unitLabel(app.unit)} />
          </dd>
        </div>
        <div>
          <dt>运行时间</dt>
          <dd>{uptime ?? "—"}</dd>
        </div>
        <div>
          <dt>服务</dt>
          <dd className="mono">{app.unit.name}</dd>
        </div>
      </dl>
      <footer className="app-actions">
        {!installed ? (
          <span className="muted">组件包未安装，无法启用</span>
        ) : confirming ? (
          <div className="confirm" role="alertdialog" aria-label={`切换到 ${app.name}`}>
            <span>当前远程会话会断开，确认切换？</span>
            <button className="button primary" onClick={onConfirm} disabled={busy}>
              切换
            </button>
            <button className="button" onClick={onCancel} disabled={busy}>
              取消
            </button>
          </div>
        ) : selected ? (
          <>
            <a className={`button primary${running ? "" : " is-disabled"}`} href={kvmURL(app.port, app.id)} aria-disabled={!running}>
              打开界面
            </a>
            <button className="button" onClick={onRestart} disabled={busy}>
              重启
            </button>
          </>
        ) : (
          <button className="button" onClick={onChoose} disabled={busy}>
            启用此界面
          </button>
        )}
      </footer>
    </article>
  );
}

function Tile({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: Tone }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">
        {tone && <span className={`tile-mark status-${tone}`} aria-hidden="true" />}
        {value}
      </span>
      {detail && <span className="tile-detail">{detail}</span>}
    </div>
  );
}

function tempTone(c: number): Tone {
  return c >= 85 ? "critical" : c >= 70 ? "warning" : "good";
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
    <div className="tiles">
      <Tile label="HDMI 输入" value={hdmiValue} detail={[hdmiDetail, capture].filter(Boolean).join(" · ")} tone={h.signal ? "good" : "warning"} />
      <Tile
        label="USB 键鼠"
        value={usbConfigured ? "已连接" : hw.usb ? hw.usb : "未知"}
        detail={usbConfigured ? "被控机已枚举键盘与鼠标" : "等待被控机枚举"}
        tone={usbConfigured ? "good" : "warning"}
      />
      <Tile label="运行时间" value={duration(hw.uptimeSeconds)} detail={`负载 ${hw.load1.toFixed(2)} · ${hw.cpus} 核`} />
    </div>
  );
}

const WINDOW_MS = 15 * 60 * 1000;

const percent = (v: number) => `${Math.round(v)}%`;
const celsius = (v: number) => `${v.toFixed(1)} °C`;

function TrendCard({
  title,
  value,
  detail,
  tone,
  children,
}: {
  title: string;
  value: string;
  detail: string;
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <figure className="card trend">
      <figcaption>
        <span className="tile-label">{title}</span>
        <span className="trend-value">
          {tone && <span className={`tile-mark status-${tone}`} aria-hidden="true" />}
          {value}
        </span>
        <span className="tile-detail">{detail}</span>
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
        detail={`${hw.fanAuto ? "自动调速" : "手动"} · 占空比，无转速反馈`}
      >
        <TrendChart label="风扇占空比" points={fan} domain={[0, 100]} ticks={[0, 50, 100]} format={percent} {...shared} />
      </TrendCard>
    </div>
  );
}

function Thermal({ hw }: { hw: Hardware }) {
  const max = 100;
  return (
    <div className="thermal">
      <section className="card" aria-labelledby="zones-title">
        <h3 id="zones-title" className="tile-label">
          各区温度
        </h3>
        <ul className="zones">
          {hw.zones.map((z) => (
            <li key={z.name}>
              <span className="zone-name">{z.name.toUpperCase()}</span>
              <Meter fraction={z.tempC / max} tone={tempTone(z.tempC)} />
              <span className="zone-value">{celsius(z.tempC)}</span>
            </li>
          ))}
        </ul>
      </section>
      {hw.fanCurve && (
        <section className="card" aria-labelledby="curve-title">
          <h3 id="curve-title" className="tile-label">
            {hw.fanAuto ? "自动风扇曲线" : "自动风扇曲线（当前为手动）"}
          </h3>
          <p className="tile-detail">
            按 SoC 温度设定占空比，每 30 秒最多变化 5%；圆点为当前 {hw.tempC.toFixed(1)} °C · {hw.fanPercent}%
          </p>
          <FanCurveChart curve={hw.fanCurve} tempC={hw.tempC} percent={hw.fanPercent} />
        </section>
      )}
    </div>
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
    <ul className="services">
      {services.map((p) => (
        <li key={p.unit.name}>
          <div className="service-name">
            <span>{p.name}</span>
            <span className="mono muted">{p.unit.name}</span>
          </div>
          <span className="muted service-since">{since(p.unit, now) ?? ""}</span>
          <StatusDot tone={unitTone(p.unit)} label={unitLabel(p.unit)} />
          <span className="service-action">
            {p.restartable && (
              <button className="button small" disabled={busy || !p.unit.loaded} onClick={() => onRestart(p.unit.name, p.name)}>
                重启
              </button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function App() {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const [notice, setNotice] = useState<{ tone: Tone; text: string }>();
  const [now, setNow] = useState(Date.now());
  const timer = useRef<number>(undefined);

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

  const run = async (label: string, action: () => Promise<unknown>, done: string) => {
    setBusy(label);
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
      setNotice({ tone: "good", text: done });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
      setConfirming(undefined);
      refresh();
    }
  };

  const active = status?.apps.find((a) => a.id === status.active);

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <rect x="3" y="6" width="26" height="17" rx="3" />
            <rect x="11" y="25" width="10" height="2" rx="1" />
          </svg>
          <div>
            <h1>VIM4 KVM</h1>
            <span className="muted">{status ? `${status.hardware.hostname} · ${status.hardware.kernel}` : "正在连接…"}</span>
          </div>
        </div>
        <StatusDot tone={stale ? "critical" : status ? "good" : "warning"} label={stale ? "连接中断" : status ? "已连接" : "连接中"} />
      </header>

      <main>
        {(error || notice || busy) && (
          <div className={`banner banner-${error ? "critical" : busy ? "warning" : notice?.tone}`} role="status">
            <span className="status-icon" aria-hidden="true">
              {error ? "!" : busy ? "…" : "✓"}
            </span>
            <span>{error ?? busy ?? notice?.text}</span>
            {!busy && (
              <button className="banner-close" aria-label="关闭" onClick={() => (setError(undefined), setNotice(undefined))}>
                ×
              </button>
            )}
          </div>
        )}

        <section aria-labelledby="apps-title">
          <div className="section-head">
            <h2 id="apps-title">KVM 界面</h2>
            <p className="muted">
              所有界面共用 HDMI 采集、硬件编码器和键鼠，同一时间只运行一个。选择会在重启后保持。
            </p>
          </div>
          {status ? (
            <div className="apps">
              {status.apps.map((app) => (
                <AppCard
                  key={app.id}
                  app={app}
                  now={now}
                  selected={app.id === status.active}
                  busy={!!busy}
                  confirming={confirming === app.id}
                  onChoose={() => setConfirming(app.id)}
                  onCancel={() => setConfirming(undefined)}
                  onConfirm={() => run(`正在切换到 ${app.name}…`, () => selectApp(app.id), `已切换到 ${app.name}`)}
                  onRestart={() => run(`正在重启 ${app.name}…`, () => restartUnit(app.unit.name), `${app.name} 已重启`)}
                />
              ))}
            </div>
          ) : (
            <div className="apps">
              <div className="app-card skeleton" />
              <div className="app-card skeleton" />
            </div>
          )}
          {status && !active && <p className="hint">尚未启用任何界面，选择一个即可开机自动启动。</p>}
        </section>

        <WifiControl busy={!!busy} />
        <EDIDPanel busy={!!busy} run={run} />

        {status && (
          <>
            <section aria-labelledby="board-title">
              <div className="section-head">
                <h2 id="board-title">板子状态</h2>
                <p className="muted">趋势每 5 秒采样，保留最近 15 分钟，管理服务重启后重新开始。</p>
              </div>
              <div className="board">
                <LinkTiles hw={status.hardware} />
                <BoardCharts hw={status.hardware} history={status.history} now={now} />
                <Thermal hw={status.hardware} />
              </div>
            </section>

            <section aria-labelledby="hdr-title">
              <div className="section-head">
                <h2 id="hdr-title">HDR 转 SDR</h2>
                <p className="muted">被控机输出 HDR 时，采集端把它映射为 SDR 再编码。画面偏暗就提高桌面亮度，高光发白就扩大高光范围。</p>
              </div>
              <HDRPanel
                curve={status.hardware.hdrCurve}
                hdr={status.hardware.hdmi.hdr}
                busy={!!busy}
                onPreview={previewHDRCurve}
                onSave={(curve) =>
                  run("正在保存 HDR 映射…", () => setHDRCurve(curve), `HDR 映射已保存：SDR 白 ${curve.white} 尼特，高光保留到 ${curve.peak} 尼特`)
                }
              />
            </section>

            <section aria-labelledby="platform-title">
              <div className="section-head">
                <h2 id="platform-title">底层服务</h2>
                <p className="muted">所有界面共用。重启 HDMI 采集时会先暂停当前界面，完成后自动恢复。</p>
              </div>
              <PlatformList
                services={status.platform}
                busy={!!busy}
                now={now}
                onRestart={(unit, name) => run(`正在重启${name}…`, () => restartUnit(unit), `${name}已重启`)}
              />
            </section>
          </>
        )}
      </main>
    </div>
  );
}

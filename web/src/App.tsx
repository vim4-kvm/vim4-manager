import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_HDR_CURVE,
  getStatus,
  restartUnit,
  selectApp,
  setHDRCurve,
  type App as KvmApp,
  type Hardware,
  type HDRCurve,
  type Platform,
  type Status,
  type Unit,
} from "./api";

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

function Meter({ fraction, tone }: { fraction: number; tone: Tone }) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <span className={`meter meter-${tone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

function HardwareTiles({ hw }: { hw: Hardware }) {
  const h = hw.hdmi;
  const hdmiValue = h.signal ? `${h.width}×${h.height}` : "无信号";
  const hdmiDetail = h.signal
    ? [`${h.refreshHz?.toFixed(2).replace(/\.?0+$/, "")} Hz`, h.colorSpace, hdrLabel(h.hdr), h.audio ? "有声音" : "无声音"]
        .filter(Boolean)
        .join(" · ")
    : "检查被控机 HDMI 输出";
  const capture = h.captureWidth ? `采集 ${h.captureWidth}×${h.captureHeight}` : undefined;
  const memUsed = hw.memTotalKiB ? 1 - hw.memAvailableKiB / hw.memTotalKiB : 0;
  const tempTone: Tone = hw.tempC >= 85 ? "critical" : hw.tempC >= 70 ? "warning" : "good";
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
      <div className="tile">
        <span className="tile-label">温度</span>
        <span className="tile-value">
          <span className={`tile-mark status-${tempTone}`} aria-hidden="true" />
          {hw.tempC.toFixed(1)} °C
        </span>
        <span className="tile-detail">
          风扇 {hw.fanPercent}% · {hw.fanAuto ? "自动" : "手动"}
        </span>
      </div>
      <div className="tile">
        <span className="tile-label">内存</span>
        <span className="tile-value">{Math.round(memUsed * 100)}%</span>
        <Meter fraction={memUsed} tone={memUsed > 0.9 ? "critical" : memUsed > 0.75 ? "warning" : "good"} />
        <span className="tile-detail">
          可用 {(hw.memAvailableKiB / 1048576).toFixed(1)} / {(hw.memTotalKiB / 1048576).toFixed(1)} GiB
        </span>
      </div>
      <Tile label="运行时间" value={duration(hw.uptimeSeconds)} detail={`负载 ${hw.load1.toFixed(2)} · ${hw.cpus} 核`} />
    </div>
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

function HDRPanel({
  curve,
  hdr,
  busy,
  onApply,
}: {
  curve: HDRCurve;
  hdr?: string;
  busy: boolean;
  onApply: (curve: HDRCurve) => void;
}) {
  const [white, setWhite] = useState(String(curve.white));
  const [peak, setPeak] = useState(String(curve.peak));
  // Follow the saved values until the user edits a field.
  const saved = `${curve.white}/${curve.peak}`;
  const [shown, setShown] = useState(saved);
  if (shown !== saved) {
    setShown(saved);
    setWhite(String(curve.white));
    setPeak(String(curve.peak));
  }
  const w = Number(white);
  const p = Number(peak);
  const invalid =
    !Number.isInteger(w) || w < 80 || w > 1000
      ? "SDR 白需为 80–1000 的整数"
      : !Number.isInteger(p) || p <= w || p > 10000
        ? "高光上限需大于 SDR 白且不超过 10000"
        : undefined;
  const changed = w !== curve.white || p !== curve.peak;
  const isDefault = curve.white === DEFAULT_HDR_CURVE.white && curve.peak === DEFAULT_HDR_CURVE.peak;
  const label = hdrLabel(hdr);
  return (
    <div className="hdr-panel">
      <div className="hdr-fields">
        <label className="field">
          <span>SDR 白（尼特）</span>
          <input type="number" inputMode="numeric" min={80} max={1000} value={white} disabled={busy} onChange={(e) => setWhite(e.target.value)} />
          <small className="muted">主机界面白色的亮度。macOS 实测约 199，默认 203（BT.2408）</small>
        </label>
        <label className="field">
          <span>高光上限（尼特）</span>
          <input type="number" inputMode="numeric" min={w + 1} max={10000} value={peak} disabled={busy} onChange={(e) => setPeak(e.target.value)} />
          <small className="muted">高于此亮度的高光不再保留层次</small>
        </label>
      </div>
      <div className="hdr-actions">
        <span className={invalid ? "status status-critical" : "muted"}>
          {invalid ?? (label ? `当前输入：${label}${label === "SDR" ? "，曲线仅在 HDR 输入时生效" : ""}` : "当前无 HDMI 信号")}
        </span>
        <button className="button" disabled={busy || isDefault} onClick={() => onApply(DEFAULT_HDR_CURVE)}>
          恢复默认
        </button>
        <button className="button primary" disabled={busy || !changed || !!invalid} onClick={() => onApply({ white: w, peak: p })}>
          应用
        </button>
      </div>
    </div>
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
              两个界面共用 HDMI 采集、硬件编码器和键鼠，同一时间只运行一个。选择会在重启后保持。
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

        {status && (
          <>
            <section aria-labelledby="board-title">
              <div className="section-head">
                <h2 id="board-title">板子状态</h2>
              </div>
              <HardwareTiles hw={status.hardware} />
            </section>

            <section aria-labelledby="hdr-title">
              <div className="section-head">
                <h2 id="hdr-title">HDR 转 SDR</h2>
                <p className="muted">
                  被控机输出 HDR 时，采集端把它映射为 SDR 再编码。画面偏暗或过曝时调整 SDR 白；应用会重启 HDMI 采集，画面中断几秒。
                </p>
              </div>
              <HDRPanel
                curve={status.hardware.hdrCurve}
                hdr={status.hardware.hdmi.hdr}
                busy={!!busy}
                onApply={(curve) =>
                  run("正在应用 HDR 映射并重启 HDMI 采集…", () => setHDRCurve(curve), `HDR 映射已更新：SDR 白 ${curve.white}，高光上限 ${curve.peak}`)
                }
              />
            </section>

            <section aria-labelledby="platform-title">
              <div className="section-head">
                <h2 id="platform-title">底层服务</h2>
                <p className="muted">两个界面共用。重启 HDMI 采集时会先暂停当前界面，完成后自动恢复。</p>
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

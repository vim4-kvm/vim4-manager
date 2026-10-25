import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { TailscalePanel } from "./TailscalePanel";
import { WifiControl } from "./WifiControl";
import { Video } from "./pages/Video";
import { KernelPanel } from "./KernelPanel";
import {
  restartUnit,
  selectApp,
  setFanCurve,
  type App as KvmApp,
  type Hardware,
  type Platform,
} from "./api";
import { FanPanel } from "./FanPanel";
import { UpdatesPanel } from "./UpdatesPanel";
import { MediaPanel, MediaSummary, MediaWait, needsMediaEject } from "./MediaPanel";
import { DiskPanel } from "./DiskPanel";
import { StoragePanel } from "./StoragePanel";
import { AccountPanel } from "./AccountPanel";
import { celsius, kvmURL, since, tempTone, unitLabel, unitTone } from "./lib/units";
import { Overview } from "./pages/Overview";
import { PassthroughPanel } from "./pages/PassthroughPanel";
import { AppShell } from "./shell/AppShell";
import { pageFromHash, type PageId } from "./shell/pages";
import { report, useActionStore, type Run } from "./stores/action";
import { useStatusPolling, useStatusStore } from "./stores/status";

type Tone = "good" | "warning" | "critical" | "idle";

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
    <div className="card table-card"><table className="table">
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
    </table></div>
  );
}

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

function usePage(): PageId {
  const [page, setPage] = useState(pageFromHash);
  useEffect(() => {
    const change = () => setPage(pageFromHash());
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  return page;
}

export function App() {
  useStatusPolling();
  const page = usePage();
  const { status, stale, now } = useStatusStore(useShallow((s) => ({ status: s.status, stale: s.stale, now: s.now })));
  const busy = useActionStore((s) => s.busy);
  const runAction = useActionStore((s) => s.run);
  const [confirming, setConfirming] = useState<string>();
  const [waiting, setWaiting] = useState<{ app: KvmApp; source: string; started: number }>();
  const waitingRef = useRef(false);

  useEffect(() => {
    setConfirming(undefined);
  }, [page]);

  const run: Run = async (label, action, done) => {
    const ok = await runAction(label, action, done);
    setConfirming(undefined);
    return ok;
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
      report("warning", "已取消等待切换，请确认当前状态后重新选择。");
      return;
    }
    if (!status.media.inserted) {
      // Clear the ref synchronously: repeated renders/StrictMode must not
      // submit the same switch twice. The root helper rechecks the LUN.
      void switchApp(waiting.app);
    }
  }, [waiting, status, stale, page]);

  const hw = status?.hardware;
  const legacy = !["overview", "output", "video", "media", "disks", "storage"].includes(page);

  return (
    <AppShell page={page} legacy={legacy}>
      {page === "overview" && <Overview />}
      {page === "output" && <PassthroughPanel />}
      {page === "account" && <AccountPanel />}
      {page === "network" && (
        <>
          <WifiControl busy={!!busy} />
          <TailscalePanel busy={!!busy} />
        </>
      )}
      {page === "storage" && <StoragePanel />}
      {page === "updates" && <>
        <Section title="内核" description="切换 5.15 与 7.x，共用当前系统数据。">
          <KernelPanel busy={!!busy} run={run} />
        </Section>
        <UpdatesPanel busy={!!busy} run={run} active={status?.active} />
      </>}
      {page === "video" && <Video />}

      {!status ? (
        legacy && page !== "network" && page !== "video" && page !== "updates" && page !== "storage" && page !== "account" && <div className="skeleton" />
      ) : (
        <>
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
                        toast.dismiss();
                      } else void switchApp(app);
                    }}
                    onRestart={() => run(`正在重启 ${app.name}…`, () => restartUnit(app.unit.name), `${app.name} 已重启`)}
                  />
                ))}
              </ul>
              {!status.apps.some((a) => a.id === status.active) && <p className="hint">尚未启用任何界面，选择一个即可开机自动启动。</p>}
            </>
          )}

          {page === "media" && <MediaPanel />}

          {page === "disks" && <DiskPanel />}


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
    </AppShell>
  );
}

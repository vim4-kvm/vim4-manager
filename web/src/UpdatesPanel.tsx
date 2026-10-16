import { useCallback, useEffect, useState } from "react";
import { getUpdates, installUpdate, type Update } from "./api";
import { DevelopmentTag, isDevelopmentVersion } from "./DevelopmentTag";

type Run = (label: string, action: () => Promise<unknown>, done: string) => Promise<boolean>;

// NanoKVM, JetKVM and One-KVM install updates from their own settings page,
// which is only reachable while that application is the running one.
const SELF_SERVICE: Record<string, string> = { "vim4-nanokvm": "nanokvm", "vim4-jetkvm": "jetkvm", "vim4-onekvm": "onekvm" };

function state(update: Update): { tone: string; label: string } {
  if (!update.installed) return { tone: "idle", label: "未安装" };
  if (update.error) return { tone: "warning", label: update.error };
  if (update.available) return { tone: "warning", label: `可更新到 ${update.latest}` };
  if (isDevelopmentVersion(update.installed)) return { tone: "idle", label: "暂无更新的正式版" };
  return { tone: "good", label: "已是最新" };
}

export function UpdatesPanel({ busy, run, active }: { busy: boolean; run: Run; active?: string }) {
  const [updates, setUpdates] = useState<Update[]>();
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState<string>();

  const check = useCallback(async (signal?: AbortSignal) => {
    setChecking(true);
    try {
      const next = await getUpdates(signal);
      if (!signal?.aborted) (setUpdates(next), setError(undefined));
    } catch (e) {
      if (!signal?.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!signal?.aborted) setChecking(false);
    }
  }, []);

  useEffect(() => {
    // Releases change rarely; check on open and after each installation.
    if (busy) return;
    const controller = new AbortController();
    void check(controller.signal);
    return () => controller.abort();
  }, [busy, check]);

  const install = (update: Update) => {
    setConfirming(undefined);
    const restart = update.package === "vim4-manager" ? "，面板几秒后自动重新连接" : "";
    void run(`正在下载并安装 ${update.name} ${update.latest}…`, () => installUpdate(update.package),
      `${update.name} 已更新到 ${update.latest}${restart}`);
  };

  return (
    <div className="updates">
      <div className="updates-head">
        <span className="muted">从各项目在 GitHub 上的最新发布检查。平台组件（内核、采集、编码）需通过组件包或镜像升级。</span>
        <button className="button small" disabled={busy || checking} onClick={() => void check()}>
          {checking ? "检查中…" : "重新检查"}
        </button>
      </div>
      {error && <p className="edid-error" role="alert">检查失败：{error}</p>}
      {!updates ? (
        !error && <div className="skeleton" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>项目</th>
              <th className="hide-narrow">已安装</th>
              <th>状态</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {updates.map((update) => {
              const { tone, label } = state(update);
              return (
                <tr key={update.package}>
                  <td>
                    <span className="cell-title">{update.name}<DevelopmentTag version={update.installed} /></span>
                    <a className="mono muted" href={`https://github.com/vim4-kvm/${update.repo}/releases`} target="_blank" rel="noreferrer">
                      {update.repo}
                    </a>
                  </td>
                  <td className="mono muted hide-narrow package-version">{update.installed || "—"}</td>
                  <td>
                    <span className={`status status-${tone}`}>
                      <span className="lamp" aria-hidden="true" />
                      {label}
                    </span>
                    {update.available && update.selfService && active !== SELF_SERVICE[update.package] && (
                      <span className="muted update-hint">切换到 {update.name} 后在其设置中更新</span>
                    )}
                  </td>
                  <td className="cell-action">
                    {update.available && update.selfService && active === SELF_SERVICE[update.package] && (
                      <a className="button small" href={`${location.protocol}//${location.hostname}:8080/?kvm=${active}`}>
                        在 {update.name} 中更新
                      </a>
                    )}
                    {update.available && !update.selfService && (
                      confirming === update.package ? (
                        <span className="confirm" role="alertdialog" aria-label={`确认更新 ${update.name}`}>
                          <span>{update.package === "vim4-pikvm" ? "PiKVM 运行中会重启。" : "管理面板会重启。"}</span>
                          <button className="button small" onClick={() => setConfirming(undefined)}>取消</button>
                          <button className="button small primary" disabled={busy} onClick={() => install(update)}>更新</button>
                        </span>
                      ) : (
                        <button className="button small primary" disabled={busy} onClick={() => setConfirming(update.package)}>
                          更新
                        </button>
                      )
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

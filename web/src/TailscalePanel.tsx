import { useEffect, useState } from "react";
import { request } from "./api";
import { CopyButton } from "./Icons";
import { TailscaleDevices, type TailscaleDevice } from "./TailscaleDevices";

export const OFFICIAL_CONTROL = "https://controlplane.tailscale.com";

export interface TailscaleState {
  installed: boolean;
  writable?: boolean;
  running?: boolean;
  backendState?: string;
  authURL?: string;
  hostName?: string;
  dnsName?: string;
  ips?: string[];
  tailnet?: string;
  controlURL?: string;
  version?: string;
  peers?: number;
  peersOnline?: number;
  devices?: TailscaleDevice[];
  job?: { action: string; running: boolean; error?: string };
}

type Action = "install" | "uninstall" | "up" | "down" | "login" | "logout";

const JOB_LABEL: Record<string, string> = { install: "正在安装 Tailscale", uninstall: "正在卸载 Tailscale" };
const CONTROL_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;

function accessURLs(state: TailscaleState) {
  const ip = state.ips?.find((a) => !a.includes(":"));
  const urls: { label: string; url: string }[] = [];
  if (ip) urls.push({ label: "KVM 界面", url: `http://${ip}:8080` });
  if (state.dnsName) urls.push({ label: "MagicDNS", url: `http://${state.dnsName}:8080` });
  if (ip) urls.push({ label: "管理面板", url: `http://${ip}` });
  return urls;
}

function phase(state: TailscaleState) {
  if (!state.installed) return "absent";
  if (!state.running) return "daemon-off";
  switch (state.backendState) {
    case "Running":
      return "online";
    case "Stopped":
      return "offline";
    case "NeedsMachineAuth":
      return "approval";
    case "Starting":
      return "starting";
    default:
      return "login";
  }
}

export function TailscalePanel({ busy }: { busy: boolean }) {
  const [state, setState] = useState<TailscaleState>();
  const [stale, setStale] = useState(true);
  const [pending, setPending] = useState<Action>();
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<"down" | "logout" | "uninstall" | "login">();
  const [changing, setChanging] = useState(false);
  const [custom, setCustom] = useState(false);
  const [control, setControl] = useState("");
  const [authURL, setAuthURL] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer: number;
    async function refresh() {
      try {
        const next = await request<TailscaleState>("/api/tailscale", undefined, AbortSignal.timeout(12000));
        if (!cancelled) {
          setState(next);
          setStale(false);
        }
      } catch {
        if (!cancelled) setStale(true);
      } finally {
        if (!cancelled) timer = window.setTimeout(refresh, 3000);
      }
    }
    void refresh();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pending]);

  const current = state ? phase(state) : undefined;
  const job = state?.job;
  const jobRunning = !!job?.running;
  const writable = state?.writable !== false;
  const locked = busy || stale || !!pending || jobRunning || !writable;
  const candidateLink = current === "login" ? state?.authURL || authURL : "";
  const link = candidateLink && /^https?:\/\/[^\s]+$/i.test(candidateLink) ? candidateLink : "";

  useEffect(() => {
    if (current !== "login") setAuthURL("");
  }, [current]);

  useEffect(() => {
    const url = state?.controlURL;
    if (url && url !== OFFICIAL_CONTROL && !control) {
      setCustom(true);
      setControl(url);
    }
  }, [state?.controlURL]);

  async function act(action: Action) {
    setPending(action);
    setError("");
    setAuthURL("");
    setConfirming(undefined);
    try {
      const body: { action: Action; controlURL?: string; previousControlURL?: string; confirmed?: boolean } = { action };
      if (action === "login") body.controlURL = custom ? control.trim() : OFFICIAL_CONTROL;
      if (action === "down" || action === "logout" || action === "uninstall") body.confirmed = true;
      if (action === "login" && changing && state?.controlURL !== body.controlURL) {
        body.previousControlURL = state?.controlURL;
        body.confirmed = true;
      }
      const result = await request<{ authURL?: string }>("/api/tailscale", body, AbortSignal.timeout(70000));
      if (action === "login" && result.authURL) setAuthURL(result.authURL);
      if (action === "login") setChanging(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStale(true);
      setPending(undefined);
    }
  }

  const controlValid = !custom || CONTROL_PATTERN.test(control.trim());
  const connected = current === "online";
  const switchable = current === "online" || current === "offline" || current === "daemon-off";
  const label = jobRunning
    ? `${JOB_LABEL[job!.action] ?? "正在处理"}…`
    : pending
      ? "正在处理…"
      : stale
        ? "状态暂不可用"
        : {
            absent: "未安装",
            "daemon-off": "服务未运行",
            offline: "已断开",
            online: "已连接",
            approval: "等待批准",
            starting: "正在连接…",
            login: "未登录",
          }[current ?? "absent"];

  return (
    <section aria-label="Tailscale">
      <div className="wifi-card tailscale-card">
        <div className="wifi-row">
          <div>
            <h3>Tailscale</h3>
            <p className="muted">把板子加入 tailnet，在外网通过 Tailscale 地址访问管理面板和 KVM 界面。</p>
          </div>
          <div className="wifi-action">
            <span className="muted" role="status">
              {(jobRunning || pending) && <span className="spinner" aria-hidden="true" />}
              {label}
            </span>
            {switchable && (
              <button
                type="button"
                className="wifi-switch"
                role="switch"
                aria-label="Tailscale 连接"
                aria-checked={connected}
                disabled={locked}
                onClick={() => connected ? setConfirming("down") : void act("up")}
              >
                <span />
              </button>
            )}
          </div>
        </div>

        {state && !stale && current === "absent" && !jobRunning && (
          <div className="tailscale-body">
            <p className="muted">从 Tailscale 官方签名软件源下载安装，通常需要半分钟到几分钟。</p>
            <div>
              <button className="button primary" disabled={locked} onClick={() => void act("install")}>
                安装 Tailscale
              </button>
            </div>
          </div>
        )}

        {!writable && <p className="tailscale-note">当前通过 Tailscale 访问，只能查看状态。请通过局域网连接修改设置。</p>}

        {state && (current === "login" || changing) && !jobRunning && (
          <div className="tailscale-body">
            <fieldset className="field tailscale-control" disabled={locked}>
              <legend>控制服务器</legend>
              <div className="segmented tailscale-servers" role="group" aria-label="控制服务器">
                <button type="button" aria-pressed={!custom} onClick={() => setCustom(false)}>
                  <strong>Tailscale 官方</strong>
                  <span>login.tailscale.com</span>
                </button>
                <button type="button" aria-pressed={custom} onClick={() => setCustom(true)}>
                  <strong>自建</strong>
                  <span>Headscale 等兼容服务</span>
                </button>
              </div>
              {custom && (
                <input
                  aria-label="控制服务器地址"
                  placeholder="https://headscale.example.com"
                  value={control}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={!controlValid}
                  onChange={(e) => setControl(e.target.value)}
                />
              )}
              {custom && !controlValid && <span className="field-hint">只填协议、域名和端口，例如 https://hs.example.com:8443</span>}
            </fieldset>
            {link ? (
              <div className="tailscale-login">
                <span>在浏览器中打开登录页面并授权此设备，完成后这里会自动更新。</span>
                <a className="button primary" href={link} target="_blank" rel="noreferrer noopener">
                  打开登录页面
                </a>
                <code className="mono tailscale-url">{link}</code>
              </div>
            ) : (
              <div>
                <button
                  className="button primary"
                  disabled={locked || (custom && !control.trim()) || !controlValid}
                  aria-busy={pending === "login"}
                  onClick={() => changing && state.controlURL !== (custom ? control.trim() : OFFICIAL_CONTROL)
                    ? setConfirming("login") : void act("login")}
                >
                  {pending === "login" && <span className="spinner" aria-hidden="true" />}
                  获取登录链接
                </button>
              </div>
            )}
          </div>
        )}

        {state && current === "approval" && (
          <p className="tailscale-body muted">已登录，等待 tailnet 管理员在控制台批准此设备。</p>
        )}

        {state && (current === "online" || current === "offline") && (
          <dl className="facts tailscale-facts">
            {state.tailnet && (
              <div>
                <dt>Tailnet</dt>
                <dd>{state.tailnet}</dd>
              </div>
            )}
            <div>
              <dt>访问地址</dt>
              <dd>
                {accessURLs(state).length ? (
                  <ul className="ts-urls">
                    {accessURLs(state).map(({ label, url }) => (
                      <li key={url}>
                        <span className="ts-url-label">{label}</span>
                        <span className="ts-url-value">
                          <a className="mono" href={url} target="_blank" rel="noreferrer noopener">
                            {url}
                          </a>
                          <CopyButton text={url} label={`${label}地址`} />
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="mono">—</span>
                )}
                <span className="muted">从同一 tailnet 中的设备打开；MagicDNS 名称需该设备启用 MagicDNS。</span>
              </dd>
            </div>
            <div>
              <dt>控制服务器</dt>
              <dd className="mono">{state.controlURL || OFFICIAL_CONTROL}</dd>
            </div>
            {state.version && (
              <div>
                <dt>版本</dt>
                <dd className="mono">{state.version}</dd>
              </div>
            )}
          </dl>
        )}

        {connected && state?.devices && <TailscaleDevices devices={state.devices} writable={writable} />}

        {connected && (
          <p className="tailscale-note">
            管理面板和 KVM 界面的接口没有额外认证，接入后 tailnet 内的所有设备都能访问。请用 Tailscale ACL 限制可访问此设备的成员。
          </p>
        )}

        {state?.installed && !jobRunning && !stale && (
          <div className="tailscale-manage">
            {(current === "online" || current === "offline" || current === "approval") && (
              <button className="button small" disabled={locked} onClick={() => setChanging(!changing)}>
                {changing ? "取消切换" : "切换控制服务器"}
              </button>
            )}
            {(current === "online" || current === "offline" || current === "approval") && (
              <button className="button small" disabled={locked} onClick={() => setConfirming("logout")}>
                退出登录
              </button>
            )}
            <button className="button small" disabled={locked} onClick={() => setConfirming("uninstall")}>
              卸载
            </button>
          </div>
        )}

        {confirming && (
          <div className="confirm" role="alertdialog" aria-label={{ down: "断开 Tailscale", login: "切换控制服务器", logout: "退出 Tailscale 登录", uninstall: "卸载 Tailscale" }[confirming]}>
            <span>
              {confirming === "down" ? "断开后，通过 Tailscale 的远程会话会立即中断，需要通过局域网重新连接。"
                : confirming === "login" ? `将控制服务器从 ${state?.controlURL} 切换为 ${custom ? control.trim() : OFFICIAL_CONTROL}，需要重新授权设备。`
                : confirming === "logout"
                ? "退出后此设备从 tailnet 中移除，通过 Tailscale 地址的会话会断开，需要重新登录授权。"
                : "卸载会停止 Tailscale 并删除软件包，通过 Tailscale 地址的会话会断开。"}
            </span>
            <button className="button" onClick={() => setConfirming(undefined)}>
              取消
            </button>
            <button className="button danger" disabled={locked} onClick={() => void act(confirming)}>
              {{ down: "断开", login: "确认切换", logout: "退出登录", uninstall: "卸载" }[confirming]}
            </button>
          </div>
        )}

        {error && (
          <p className="wifi-error" role="alert">
            {error}
          </p>
        )}
        {job?.error && job.action in JOB_LABEL && job.error !== error && (
          <p className="wifi-error" role="alert">
            {job.error}
          </p>
        )}
      </div>
    </section>
  );
}

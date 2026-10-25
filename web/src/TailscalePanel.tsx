import { Segmented, SegmentedOption } from "@/components/Segmented";
import { Spinner } from "@/components/Spinner";
import { FadeIn } from "@/components/Motion";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Fact, FactGrid } from "@/components/FactGrid";
import { InlineError } from "@/components/InlineError";
import { SettingRow } from "@/components/SettingRow";
import { SettingsCard } from "@/components/SettingsCard";
import { Switch } from "@/components/ui/switch";
import { useActionStore } from "@/stores/action";
import { useEffect, useState } from "react";
import { request } from "./api";
import { CopyButton } from "@/components/CopyButton";
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

export function TailscalePanel() {
  const busy = useActionStore((s) => !!s.busy);
  const [reading, setReading] = useState(true);
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
        if (!cancelled) { setReading(false); timer = window.setTimeout(refresh, 3000); }
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
  const writable = true;
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

  if (reading && !state) return <SettingsCard label="Tailscale"><PanelSkeleton label={label} /></SettingsCard>;

  return (
    <SettingsCard label="Tailscale"><FadeIn className="flex min-w-0 flex-col gap-5">
        <SettingRow title="Tailscale" description="把板子加入 tailnet，在外网通过 Tailscale 地址访问管理面板和 KVM 界面。"
          status={label} pending={jobRunning || !!pending}
          control={switchable && <Switch aria-label="Tailscale 连接" checked={connected} disabled={locked}
            onCheckedChange={() => connected ? setConfirming("down") : void act("up")} />} />

        {state && !stale && current === "absent" && !jobRunning && (
          <div className="flex min-w-0 flex-col gap-4">
            <p className="text-muted-foreground">从 Tailscale 官方签名软件源下载安装，通常需要半分钟到几分钟。</p>
            <div>
              <Button variant="default" disabled={locked} onClick={() => void act("install")}>
                安装 Tailscale
              </Button>
            </div>
          </div>
        )}


        {state && (current === "login" || changing) && !jobRunning && (
          <div className="flex min-w-0 flex-col gap-4">
            <fieldset className="flex min-w-0 flex-col gap-3 text-sm [&_legend]:mb-2 [&_legend]:font-medium" disabled={locked}>
              <legend>控制服务器</legend>
              <Segmented label="控制服务器" className="max-sm:grid-cols-1">
                <SegmentedOption title="Tailscale 官方" detail="login.tailscale.com" pressed={!custom} onClick={() => setCustom(false)} />
                <SegmentedOption title="自建" detail="Headscale 等兼容服务" pressed={custom} onClick={() => setCustom(true)} />
              </Segmented>
              {custom && (
                <Input
                  aria-label="控制服务器地址"
                  placeholder="https://headscale.example.com"
                  value={control}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={!controlValid}
                  onChange={(e) => setControl(e.target.value)}
                />
              )}
              {custom && !controlValid && <span className="text-xs text-muted-foreground">只填协议、域名和端口，例如 https://hs.example.com:8443</span>}
            </fieldset>
            {link ? (
              <div className="flex flex-col items-start gap-3">
                <span>在浏览器中打开登录页面并授权此设备，完成后这里会自动更新。</span>
                <Button asChild variant="default"><a href={link} target="_blank" rel="noreferrer noopener">
                  打开登录页面
                </a></Button>
                <code className="font-mono break-all max-w-full break-all text-xs">{link}</code>
              </div>
            ) : (
              <div>
                <Button variant="default"
                  disabled={locked || (custom && !control.trim()) || !controlValid}
                  aria-busy={pending === "login"}
                  onClick={() => changing && state.controlURL !== (custom ? control.trim() : OFFICIAL_CONTROL)
                    ? setConfirming("login") : void act("login")}
                >
                  {pending === "login" && <Spinner />}
                  获取登录链接
                </Button>
              </div>
            )}
          </div>
        )}

        {state && current === "approval" && (
          <p className="flex min-w-0 flex-col gap-4 text-muted-foreground">已登录，等待 tailnet 管理员在控制台批准此设备。</p>
        )}

        {state && (current === "online" || current === "offline") && (
          <FactGrid cols={3}>
            {state.tailnet && (
              <Fact label="Tailnet" value={state.tailnet} />
            )}
            <Fact label="控制服务器" value={state.controlURL || OFFICIAL_CONTROL} />
            {state.version && (
              <Fact label="版本" value={state.version} />
            )}
            <Fact label="访问地址" className="@md:col-span-3" value={<div className="flex flex-col gap-2 text-sm font-normal">
                {accessURLs(state).length ? (
                  <ul className="grid grid-cols-[auto_minmax(0,auto)_1fr] items-center gap-x-4 gap-y-1 [&_li]:contents">
                    {accessURLs(state).map(({ label, url }) => (
                      <li key={url}>
                        <span className="text-xs text-muted-foreground">{label}</span>
                        <a className="font-mono [overflow-wrap:anywhere]" href={url} target="_blank" rel="noreferrer noopener">
                          {url}
                        </a>
                        <span className="justify-self-start"><CopyButton text={url} label={`${label}地址`} /></span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="font-mono break-all">—</span>
                )}
                <span className="text-xs text-muted-foreground">从同一 tailnet 中的设备打开；MagicDNS 名称需该设备启用 MagicDNS。</span>
              </div>} />
          </FactGrid>
        )}

        {connected && state?.devices && <TailscaleDevices devices={state.devices} writable={writable} />}

        {connected && (
          <p className="text-xs text-muted-foreground">
            管理面板与 KVM 界面使用统一登录；MCP、VNC 等接口使用各自的密钥。请用 Tailscale ACL 限制可访问此设备的成员。
          </p>
        )}

        {state?.installed && !jobRunning && !stale && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {(current === "online" || current === "offline" || current === "approval") && (
              <Button variant="outline" disabled={locked} onClick={() => setChanging(!changing)}>
                {changing ? "取消切换" : "切换控制服务器"}
              </Button>
            )}
            {(current === "online" || current === "offline" || current === "approval") && (
              <Button variant="outline" disabled={locked} onClick={() => setConfirming("logout")}>
                退出登录
              </Button>
            )}
            <Button variant="outline" disabled={locked} onClick={() => setConfirming("uninstall")}>
              卸载
            </Button>
          </div>
        )}

        {confirming && (
          <ConfirmDialog open title={{ down: "断开 Tailscale", login: "切换控制服务器", logout: "退出 Tailscale 登录", uninstall: "卸载 Tailscale" }[confirming]}
            description={confirming === "down" ? "断开后，通过 Tailscale 的远程会话会立即中断，需要通过局域网重新连接。"
              : confirming === "login" ? `将控制服务器从 ${state?.controlURL} 切换为 ${custom ? control.trim() : OFFICIAL_CONTROL}，需要重新授权设备。`
              : confirming === "logout" ? "退出后此设备从 tailnet 中移除，通过 Tailscale 地址的会话会断开，需要重新登录授权。"
              : "卸载会停止 Tailscale 并删除软件包，通过 Tailscale 地址的会话会断开。"}
            confirm={{ down: "断开", login: "确认切换", logout: "退出登录", uninstall: "卸载" }[confirming]}
            destructive disabled={locked} onOpenChange={(open) => { if (!open) setConfirming(undefined); }} onConfirm={() => void act(confirming)} />
        )}

        {error && (
          <InlineError>
            {error}
          </InlineError>
        )}
        {job?.error && job.action in JOB_LABEL && job.error !== error && (
          <InlineError>
            {job.error}
          </InlineError>
        )}
      </FadeIn></SettingsCard>
  );
}

import { Badge } from "@/components/ui/badge";
import { FadeIn } from "@/components/Motion";
import { AnimatedList } from "@/components/AnimatedList";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Check, Laptop, Monitor, Smartphone, Terminal } from "lucide-react";
import { Avatar } from "@/components/AccountMenu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DetailsDialog } from "@/components/DetailsDialog";
import { InlineError } from "@/components/InlineError";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingRow } from "@/components/SettingRow";
import { SettingsCard } from "@/components/SettingsCard";
import { PageHeading } from "@/components/PageHeading";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { request } from "./api";
import { logout, useAccount } from "./auth";

interface Device {
  id: string;
  address: string;
  userAgent: string;
  lastActive: string;
  current: boolean;
}

interface Account {
  username: string;
  passwordChanged: string;
  sessions: Device[];
}

type DialogMode = "password" | "username" | "others";
const RESET_COMMAND = "sudo vim4-manager set-password";
const KVM_AUTH_NOTE = "登录后可直接打开 KVM 界面（8080）；MCP、VNC 等接口使用各自的密钥。";

function deviceInfo(agent: string) {
  const tool = agent.match(/curl|wget|python-requests|go-http-client|node-fetch|undici/i)?.[0];
  if (tool) return { name: `命令行工具 · ${tool.toLowerCase()}`, icon: "terminal" };
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /Chrome\/|HeadlessChrome|Playwright/i.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "";
  const os = /iPhone|iPad/.test(agent)
    ? "iOS"
    : /Android/.test(agent)
      ? "Android"
      : /Macintosh/.test(agent)
        ? "macOS"
        : /Windows/.test(agent)
          ? "Windows"
          : /Linux/.test(agent)
            ? "Linux"
            : "";
  return {
    name: browser ? browser + (os ? ` · ${os}` : "") : "未知设备",
    icon: /iOS|Android/.test(os) ? "phone" : os ? "laptop" : "monitor",
  };
}

function addressInfo(address: string) {
  if (/^(127\.|::1$|0:0:0:0:0:0:0:1$)/i.test(address)) return { label: "经板上代理", tailscale: false, proxied: true };
  const parts = address.split(".").map(Number);
  const tailscale =
    (parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || /^fd7a:115c:a1e0:/i.test(address);
  return { label: address, tailscale, proxied: false };
}

// Long session lists bury the row you are looking for; recent ones come first.
const DEVICE_PREVIEW = 5;

function lastActive(value: string) {
  const minutes = Math.floor((Date.now() - Date.parse(value)) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}

function localDate(value: string, time = false) {
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return time ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` : day;
}

function passwordAge(value: string) {
  const date = new Date(value);
  const now = new Date();
  // Compare calendar dates, so DST and elapsed hours cannot move the day boundary.
  const days = Math.max(
    0,
    Math.round(
      (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
        Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) /
        86400000,
    ),
  );
  return days === 0 ? "今天" : `${days} 天前`;
}

export function AccountPanel() {
  const { username: signedInName, setUsername } = useAccount();
  const [account, setAccount] = useState<Account>();
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [mode, setMode] = useState<DialogMode>();
  const [currentPassword, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [username, setName] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<string[]>([]);
  const [allDevices, setAllDevices] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  async function refresh(signal?: AbortSignal) {
    setLoading(true);
    setLoadFailed(false);
    try {
      const value = await request<Account>("/api/account/sessions", undefined, signal);
      if (!signal?.aborted) {
        setAccount(value);
        setUsername(value.username);
      }
    } catch {
      if (!signal?.aborted) setLoadFailed(true);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 5000);
    return () => window.clearTimeout(timer);
  }, [message]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    if (mode) dialog.current?.querySelector<HTMLElement>("input, button")?.focus();
  }, [mode]);

  function close() {
    if (busy) return;
    setMode(undefined);
    trigger.current?.focus();
  }

  function open(value: DialogMode) {
    trigger.current = document.activeElement as HTMLElement;
    setMode(value);
    setCurrent("");
    setPassword("");
    setConfirm("");
    setName(account?.username || "");
    setError("");
    setFields({});
    setMessage("");
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      await request(
        mode === "others" ? "/api/account/logout-others" : `/api/account/${mode}`,
        mode === "others" ? {} : { currentPassword, password, username },
      );
      setMode(undefined);
      trigger.current?.focus();
      setMessage(
        mode === "others" ? "其他设备已退出" : `${mode === "password" ? "密码" : "用户名"}已修改，其他设备已退出`,
      );
      await refresh();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      if (text === "当前密码错误") setFields({ currentPassword: text });
      else setError(text);
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!currentPassword) next.currentPassword = "请输入当前密码";
    if (mode === "username") {
      if (!/^[A-Za-z0-9._-]{1,32}$/.test(username)) next.username = "用户名须为 1–32 个字母、数字、点、下划线或连字符";
      else if (username === currentPassword) next.username = "用户名不能与密码相同";
    } else {
      if ([...password].length < 8 || [...password].length > 128) next.password = "密码须为 8–128 个字符";
      else if (password === account?.username) next.password = "密码不能与用户名相同";
      if (password !== confirm) next.confirm = "两次密码不一致";
    }
    setFields(next);
    if (Object.keys(next).length) {
      dialog.current?.querySelector<HTMLInputElement>(`[name="${Object.keys(next)[0]}"]`)?.focus();
      return;
    }
    void save();
  }

  async function revoke(id: string) {
    setRevoking((value) => [...value, id]);
    setRowErrors((value) => ({ ...value, [id]: "" }));
    try {
      await request("/api/account/revoke", { id });
      setAccount((value) => value && { ...value, sessions: value.sessions.filter((device) => device.id !== id) });
    } catch (e) {
      setRowErrors((value) => ({ ...value, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setRevoking((value) => value.filter((item) => item !== id));
    }
  }

  const others = account?.sessions.filter((device) => !device.current).length || 0;
  const sessions = [...(account?.sessions || [])].sort(
    (a, b) => Number(b.current) - Number(a.current) || Date.parse(b.lastActive) - Date.parse(a.lastActive),
  );
  const title = mode === "others" ? "退出其他设备" : mode === "password" ? "修改密码" : "修改用户名";
  const inputs = [
    {
      name: "currentPassword",
      label: "当前密码",
      value: currentPassword,
      set: setCurrent,
      type: "password",
      complete: "current-password",
    },
    ...(mode === "username"
      ? [{ name: "username", label: "新用户名", value: username, set: setName, type: "text", complete: "username" }]
      : [
          {
            name: "password",
            label: "新密码",
            value: password,
            set: setPassword,
            type: "password",
            complete: "new-password",
          },
          {
            name: "confirm",
            label: "确认新密码",
            value: confirm,
            set: setConfirm,
            type: "password",
            complete: "new-password",
          },
        ]),
  ];
  return (
    <>
      <PageHeading page="account" />
      {message && (
        <div data-account-success className="flex items-center gap-3 rounded-md border border-success/30 bg-card p-3 text-sm text-success-foreground [&_button]:ml-auto [&_button]:size-7 [&_button]:border-0" role="status">
          <Check className="size-4 shrink-0" aria-hidden="true" />
          <span>{message}</span>
          <Button variant="outline" aria-label="关闭提示" onClick={() => setMessage("")}>
            ×
          </Button>
        </div>
      )}
      <SettingsCard title="管理员账户">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]">
          <div className="flex min-w-0 items-center gap-5 py-3 lg:border-r lg:pr-6">
            <Avatar username={signedInName} className="size-20 bg-chart-1/10 text-3xl text-chart-1" />
            <div className="min-w-0 space-y-1"><strong className="block break-all text-xl font-semibold">{signedInName}</strong><p className="text-sm text-muted-foreground">本机管理员</p></div>
          </div>
          <div className="@container min-w-0 divide-y [&>div]:py-4 [&>div:first-child]:pt-0 [&>div:last-child]:pb-0">
            <SettingRow title="用户名" description={signedInName} control={<Button variant="outline" aria-label="修改用户名" onClick={() => open("username")}>修改用户名</Button>} />
            <SettingRow title="密码" description={<><span className="block tracking-widest text-foreground">••••••••</span><span>{account ? `上次修改 ${localDate(account.passwordChanged)}（${passwordAge(account.passwordChanged)}）` : "—"}</span></>}
              control={<Button variant="outline" aria-label="修改密码" disabled={!account} onClick={() => open("password")}>修改密码</Button>} />
          </div>
        </div>
        {error && !mode && (
          <InlineError>
            {error}
          </InlineError>
        )}
      </SettingsCard>
      <SettingsCard data-account-devices><div className="flex min-w-0 flex-col gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3 [&>div]:min-w-0 [&>div]:flex-1 [&>div]:basis-64 [&_h3]:text-base [&_h3]:font-semibold [&_p]:mt-1 [&_p]:text-sm [&_p]:text-muted-foreground">
          <div>
            <h3>登录设备</h3>
            <p>已登录管理面板的浏览器和工具。退出后需要重新输入密码。</p>
          </div>
          {account &&
            !loading &&
            !loadFailed &&
            (others ? (
              <Button variant="outline" disabled={busy || !!revoking.length} onClick={() => open("others")}>
                退出其他设备
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">仅本设备</span>
            ))}
        </div>
        <div className="min-w-0" role="table" aria-label="登录设备" aria-busy={loading}>
          <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,180px)_100px_80px] items-center gap-3 rounded-md bg-muted/60 px-3 py-3 text-xs text-muted-foreground md:grid" role="row">
            <span role="columnheader">设备</span>
            <span role="columnheader">地址</span>
            <span role="columnheader">最后活动</span>
            <span role="columnheader" aria-label="操作" />
          </div>
          {loading ? (
            <PanelSkeleton label="正在读取登录设备" />
          ) : loadFailed ? (
            <div className="flex flex-wrap items-center gap-3 py-4 text-sm text-destructive" role="alert">
              无法读取登录设备{" "}
              <Button variant="link" size="inline" onClick={() => void refresh()}>
                重试
              </Button>
            </div>
          ) : (
            <FadeIn><AnimatedList as="div" role="rowgroup" className="[&>*:last-child>[role=row]]:border-b-0 [&>*:last-child>[role=row]]:pb-0" items={allDevices ? sessions : sessions.slice(0, DEVICE_PREVIEW)} getKey={(device) => device.id}>{(device) => {
                const info = deviceInfo(device.userAgent);
                const address = addressInfo(device.address);
                return (
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-b px-3 py-5 text-sm md:grid-cols-[minmax(0,1fr)_minmax(0,180px)_100px_80px]" role="row" key={device.id}>
                    <span className="col-start-1 row-start-1 flex min-w-0 flex-wrap items-center gap-2 [&>span]:break-all" role="cell">
                      {info.icon === "terminal" ? <Terminal className="size-4 shrink-0" /> : info.icon === "phone" ? <Smartphone className="size-4 shrink-0" /> : info.icon === "laptop" ? <Laptop className="size-4 shrink-0" /> : <Monitor className="size-4 shrink-0" />}
                      <span>{info.name}</span>
                      {device.current && <Badge variant="outline" className="border-primary/30 text-primary">本设备</Badge>}
                    </span>
                    <div className="col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-2 md:contents">
                      <span className="min-w-0 break-all text-xs text-muted-foreground md:col-start-2 md:row-start-1" role="cell">
                        <span className={address.proxied ? "" : "font-mono break-all"} title={address.proxied ? "请求经板子上的代理转发（如 KVM 网关），看不到原始地址" : undefined}>{address.label}</span>
                        {address.tailscale && <small> Tailscale</small>}
                        {rowErrors[device.id] && (
                          <span className="text-xs text-destructive" role="alert">
                            {rowErrors[device.id]}
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground md:col-start-3 md:row-start-1" role="cell" title={localDate(device.lastActive, true)}>
                        {lastActive(device.lastActive)}
                      </span>
                    </div>
                    <span className="col-start-2 row-span-2 row-start-1 justify-self-end md:col-start-4 md:row-span-1" role="cell">
                      {!device.current && (
                        <Button variant="outline"
                          disabled={revoking.includes(device.id) || busy}
                          onClick={() => void revoke(device.id)}
                        >
                          {revoking.includes(device.id) ? "退出中…" : "退出"}
                        </Button>
                      )}
                      {device.current && <span className="text-xs text-muted-foreground">当前会话</span>}
                    </span>
                  </div>
                );
              }}</AnimatedList></FadeIn>
          )}
          {!loading && !loadFailed && sessions.length > DEVICE_PREVIEW && (
            <Button variant="link" size="inline" className="mt-3 text-xs" aria-expanded={allDevices} onClick={() => setAllDevices(!allDevices)}>
              {allDevices ? "只显示最近的设备" : `显示其余 ${sessions.length - DEVICE_PREVIEW} 台设备`}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">退出设备会结束该设备的管理面板和 KVM 会话。</p>
        <div className="flex justify-end border-t pt-4">
          <Button variant="outline" disabled={busy} onClick={async () => {
            setBusy(true);
            setError("");
            try { await logout(); } catch { setError("退出失败，请重试"); setBusy(false); }
          }}>{busy && !mode ? "正在退出…" : "退出登录"}</Button>
        </div>
      </div></SettingsCard>
      <div data-account-notes className="space-y-2 text-xs text-muted-foreground [&_code]:break-all [&_code]:font-mono">
        <p>
          忘记密码时，SSH 登录板子运行 <code>{RESET_COMMAND}</code>，所有设备会同时退出。
          <Button variant="link" size="inline"
            className="ml-1 text-xs"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(RESET_COMMAND);
                setCopied(true);
              } catch {
                setError("无法复制命令，请手动复制");
              }
            }}
          >
            {copied ? "已复制" : "复制命令"}
          </Button>
        </p>
        <p>{KVM_AUTH_NOTE}</p>
      </div>
      {mode === "others" && <ConfirmDialog open title={title} description={<>其他 {others} 个设备将退出，正在使用的 KVM 连接会断开。</>}
        confirm={busy ? "正在退出…" : "确认退出"} busy={busy} closeOnConfirm={false}
        onOpenChange={(open) => { if (!open) close(); }} onConfirm={() => void save()}>
        {error && <InlineError>{error}</InlineError>}
      </ConfirmDialog>}
      {mode && mode !== "others" && <DetailsDialog open title={title} onOpenChange={(open) => { if (!open) close(); }}>
        <div ref={dialog}>
              <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
                {inputs.map((input) => (
                  <div className="flex min-w-0 flex-col gap-2 text-sm" key={input.name}>
                    <label htmlFor={input.name}>{input.label}</label>
                    <Input
                      id={input.name}
                      name={input.name}
                      type={input.type}
                      autoComplete={input.complete}
                      value={input.value}
                      readOnly={busy}
                      aria-invalid={!!fields[input.name]}
                      aria-describedby={`${input.name}-error`}
                      onChange={(event) => {
                        input.set(event.target.value);
                        setFields((value) => ({ ...value, [input.name]: "" }));
                      }}
                    />
                    <span id={`${input.name}-error`} className="min-h-4 text-xs text-destructive">
                      {fields[input.name]}
                    </span>
                  </div>
                ))}
                {error && (
                  <InlineError>
                    {error}
                  </InlineError>
                )}
                <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                  <Button variant="outline" type="button" disabled={busy} onClick={close}>
                    取消
                  </Button>
                  <Button variant="default" disabled={busy}>
                    {busy ? "正在保存…" : "保存"}
                  </Button>
                </div>
              </form>
        </div>
      </DetailsDialog>}
    </>
  );
}

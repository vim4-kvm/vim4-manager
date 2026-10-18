import { useEffect, useRef, useState, type FormEvent } from "react";
import { request } from "./api";
import { logout, useAccount } from "./auth";
import { AccountIcon, Avatar } from "./AccountMenu";
export { AccountLink, AccountRow } from "./AccountMenu";

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
  if (/^(127\.|::1$|0:0:0:0:0:0:0:1$)/i.test(address)) return { label: "本机转发", tailscale: false };
  const parts = address.split(".").map(Number);
  const tailscale =
    (parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || /^fd7a:115c:a1e0:/i.test(address);
  return { label: address, tailscale };
}

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
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const dialog = useRef<HTMLElement>(null);

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
      {message && (
        <div className="account-success" role="status">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m5 12 4 4L19 6" />
          </svg>
          <span>{message}</span>
          <button aria-label="关闭提示" onClick={() => setMessage("")}>
            ×
          </button>
        </div>
      )}
      <section className="card account-card">
        <div className="account-card-head">
          <Avatar username={signedInName} />
          <div className="account-identity">
            <strong>{signedInName}</strong>
            <small>管理员</small>
          </div>
          <button
            className="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await logout();
              } catch {
                setError("退出失败，请重试");
                setBusy(false);
              }
            }}
          >
            {busy && !mode ? "正在退出…" : "退出登录"}
          </button>
        </div>
        <dl className="account-facts">
          <div>
            <dt>用户名</dt>
            <dd>{signedInName}</dd>
            <button className="account-text-button" aria-label="修改用户名" onClick={() => open("username")}>
              修改
            </button>
          </div>
          <div>
            <dt>密码</dt>
            <dd>
              {account
                ? `上次修改 ${localDate(account.passwordChanged)}（${passwordAge(account.passwordChanged)}）`
                : "—"}
            </dd>
            <button
              className="account-text-button"
              aria-label="修改密码"
              disabled={!account}
              onClick={() => open("password")}
            >
              修改
            </button>
          </div>
        </dl>
        {error && !mode && (
          <p className="account-error" role="alert">
            {error}
          </p>
        )}
      </section>
      <section className="card account-card">
        <div className="account-card-head">
          <div>
            <h3>登录设备</h3>
            <p>已登录管理面板的浏览器和工具。退出后需要重新输入密码。</p>
          </div>
          {account &&
            !loading &&
            !loadFailed &&
            (others ? (
              <button className="button" disabled={busy || !!revoking.length} onClick={() => open("others")}>
                退出其他设备
              </button>
            ) : (
              <span className="account-only">仅本设备</span>
            ))}
        </div>
        <div className="account-devices" role="table" aria-label="登录设备" aria-busy={loading}>
          <div className="account-device-header" role="row">
            <span role="columnheader">设备</span>
            <span role="columnheader">地址</span>
            <span role="columnheader">最后活动</span>
            <span role="columnheader" aria-label="操作" />
          </div>
          {loading ? (
            [0, 1, 2].map((row) => (
              <div key={row} className="account-skeleton" aria-label="正在读取登录设备">
                <span />
              </div>
            ))
          ) : loadFailed ? (
            <div className="account-load-error" role="alert">
              无法读取登录设备{" "}
              <button className="account-text-button" onClick={() => void refresh()}>
                重试
              </button>
            </div>
          ) : (
            [...(account?.sessions || [])]
              .sort(
                (a, b) => Number(b.current) - Number(a.current) || Date.parse(b.lastActive) - Date.parse(a.lastActive),
              )
              .map((device) => {
                const info = deviceInfo(device.userAgent);
                const address = addressInfo(device.address);
                return (
                  <div className="account-device" role="row" key={device.id}>
                    <span className="account-device-name" role="cell">
                      <AccountIcon kind={info.icon} />
                      <span>{info.name}</span>
                      {device.current && <span className="tag development-tag">本设备</span>}
                    </span>
                    <div className="account-device-details">
                      <span className="account-device-address" role="cell">
                        <span className="mono">{address.label}</span>
                        {address.tailscale && <small> Tailscale</small>}
                        {rowErrors[device.id] && (
                          <span className="account-error" role="alert">
                            {rowErrors[device.id]}
                          </span>
                        )}
                      </span>
                      <span className="account-device-active" role="cell" title={localDate(device.lastActive, true)}>
                        {lastActive(device.lastActive)}
                      </span>
                    </div>
                    <span className="account-device-actions" role="cell">
                      {!device.current && (
                        <button
                          className="button small"
                          disabled={revoking.includes(device.id) || busy}
                          onClick={() => void revoke(device.id)}
                        >
                          {revoking.includes(device.id) ? "退出中…" : "退出"}
                        </button>
                      )}
                    </span>
                  </div>
                );
              })
          )}
        </div>
      </section>
      <div className="account-notes">
        <p>
          忘记密码时，SSH 登录板子运行 <code>{RESET_COMMAND}</code>，所有设备会同时退出。
          <button
            className="account-text-button"
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
          </button>
        </p>
        <p>{KVM_AUTH_NOTE}</p>
      </div>
      {mode && (
        <div
          className="auth-modal"
          onClick={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <section
            ref={dialog}
            className="card account-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
              if (event.key === "Tab") {
                const items = [...dialog.current!.querySelectorAll<HTMLElement>("input, button:not(:disabled)")];
                const first = items[0],
                  last = items[items.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last?.focus();
                }
                if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <h3>{title}</h3>
            {mode === "others" ? (
              <>
                <p>其他 {others} 个设备将退出，正在使用的 KVM 连接会断开。</p>
                {error && (
                  <p className="account-error" role="alert">
                    {error}
                  </p>
                )}
                <div className="account-dialog-actions">
                  <button className="button" disabled={busy} onClick={close}>
                    取消
                  </button>
                  <button className="button primary" disabled={busy} onClick={() => void save()}>
                    {busy ? "正在退出…" : "确认退出"}
                  </button>
                </div>
              </>
            ) : (
              <form className="account-form" onSubmit={submit} noValidate>
                {inputs.map((input) => (
                  <div className="account-field" key={input.name}>
                    <label htmlFor={input.name}>{input.label}</label>
                    <input
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
                    <span id={`${input.name}-error`} className="account-field-error">
                      {fields[input.name]}
                    </span>
                  </div>
                ))}
                {error && (
                  <p className="account-error" role="alert">
                    {error}
                  </p>
                )}
                <div className="account-dialog-actions">
                  <button type="button" className="button" disabled={busy} onClick={close}>
                    取消
                  </button>
                  <button className="button primary" disabled={busy}>
                    {busy ? "正在保存…" : "保存"}
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}
    </>
  );
}

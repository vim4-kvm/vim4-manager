import { useEffect, useState, type FormEvent } from "react";
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

function browserName(agent: string) {
  if (/Edg\//.test(agent)) return "Edge";
  if (/Firefox\//.test(agent)) return "Firefox";
  if (/Chrome\//.test(agent)) return "Chrome";
  if (/Safari\//.test(agent)) return "Safari";
  return "未知浏览器";
}

function systemName(agent: string) {
  if (/iPhone|iPad/.test(agent)) return "iOS";
  if (/Android/.test(agent)) return "Android";
  if (/Macintosh/.test(agent)) return "macOS";
  if (/Windows/.test(agent)) return "Windows";
  if (/Linux/.test(agent)) return "Linux";
  return "";
}

function deviceName(agent: string) {
  const browser = browserName(agent);
  const os = systemName(agent);
  return browser + (os ? ` · ${os}` : "");
}

function lastActive(value: string) {
  const minutes = Math.floor((Date.now() - Date.parse(value)) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}

function passwordDate(value: string) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dialogTitle(mode: DialogMode) {
  if (mode === "others") return "退出其他设备";
  if (mode === "password") return "修改密码";
  return "修改用户名";
}

export function AccountLink({ compact = false }: { compact?: boolean }) {
  const { username } = useAccount();
  return (
    <a
      className={compact ? "account-link account-link-compact" : "account-link"}
      href="#/account"
      aria-label={`账户 ${username}`}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="7" r="4" />
        <path d="M4 22v-3a8 8 0 0 1 16 0v3" />
      </svg>
      {!compact && <span>{username}</span>}
    </a>
  );
}

export function AccountRow() {
  const [error, setError] = useState("");
  return (
    <div className="account-foot">
      <AccountLink />
      <button className="button" onClick={() => logout().catch((e) => setError(e.message))}>
        退出
      </button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}

export function AccountPanel() {
  const { setUsername } = useAccount();
  const [account, setAccount] = useState<Account>();
  const [mode, setMode] = useState<DialogMode>();
  const [currentPassword, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [username, setName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const value = await request<Account>("/api/account/sessions");
    setAccount(value);
    setUsername(value.username);
  }

  useEffect(() => {
    refresh().catch((e) => setMessage(e.message));
  }, []);

  function open(value: typeof mode) {
    setMode(value);
    setCurrent("");
    setPassword("");
    setConfirm("");
    setName(account?.username || "");
    setMessage("");
  }

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setMessage("");
    try {
      await action();
      setMode(undefined);
      setMessage(message);
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      await logout();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    await run(
      () => request(`/api/account/${mode}`, { currentPassword, password, username }),
      mode === "password" ? "密码已修改，其他设备已退出" : "用户名已修改，其他设备已退出",
    );
  }

  const valid =
    mode === "username"
      ? /^[A-Za-z0-9._-]{1,32}$/.test(username) && username !== currentPassword
      : [...password].length >= 8 &&
        [...password].length <= 128 &&
        password !== account?.username &&
        password === confirm;
  return (
    <>
      <p role="status">{message}</p>
      {account && (
        <>
          <section className="card account-card">
            <h3>登录信息</h3>
            <div className="account-info">
              <span>用户名　{account.username}</span>
              <button className="button" onClick={() => open("username")}>
                修改用户名
              </button>
            </div>
            <div className="account-info">
              <span>密码　上次修改 {passwordDate(account.passwordChanged)}</span>
              <button className="button" onClick={() => open("password")}>
                修改密码
              </button>
            </div>
            <button className="button" disabled={busy} onClick={signOut}>
              退出登录
            </button>
          </section>
          <section className="card account-card">
            <div className="account-info">
              <h3>登录设备　{account.sessions.length} 个</h3>
              <button className="button" disabled={busy || account.sessions.length < 2} onClick={() => open("others")}>
                退出其他设备
              </button>
            </div>
            <div className="account-devices">
              {[...account.sessions]
                .sort(
                  (a, b) =>
                    Number(b.current) - Number(a.current) || Date.parse(b.lastActive) - Date.parse(a.lastActive),
                )
                .map((device) => (
                  <div className="account-device" key={device.id}>
                    <span className="account-device-name">
                      {device.current && "● 本设备　"}
                      {deviceName(device.userAgent)}
                    </span>
                    <span className="account-device-address muted">
                      {device.address}
                      {/^(127\.|::1$)/.test(device.address) && "(转发)"}
                    </span>
                    <span className="account-device-active muted">{lastActive(device.lastActive)}</span>
                    <span className="account-device-actions">
                      {!device.current && (
                        <button
                          className="button"
                          disabled={busy}
                          onClick={() => run(() => request("/api/account/revoke", { id: device.id }), "设备已退出")}
                        >
                          退出
                        </button>
                      )}
                    </span>
                  </div>
                ))}
            </div>
          </section>
          <section className="card account-card">
            <h3>说明</h3>
            <p>
              当前账户保护管理面板；KVM 界面（8080）仍使用应用现有登录方式。MCP、VNC 等接口使用各自的密钥，在对应 KVM
              界面中管理。
            </p>
            <p>
              忘记密码：SSH 登录板子运行 <code>sudo vim4-manager set-password</code>
            </p>
          </section>
          {mode && (
            <div className="auth-modal">
              <section className="card account-card" role="dialog" aria-modal="true" aria-label={dialogTitle(mode)}>
                <h3>{dialogTitle(mode)}</h3>
                {mode === "others" ? (
                  <>
                    <p>
                      其他 {account.sessions.filter((d) => !d.current).length} 个设备将退出，正在使用的 KVM 连接会断开。
                    </p>
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => run(() => request("/api/account/logout-others", {}), "其他设备已退出")}
                    >
                      确认退出
                    </button>
                  </>
                ) : (
                  <form onSubmit={submit} className="account-form">
                    <label>
                      当前密码
                      <input
                        autoFocus
                        type="password"
                        autoComplete="current-password"
                        value={currentPassword}
                        onChange={(e) => setCurrent(e.target.value)}
                        readOnly={busy}
                      />
                    </label>
                    {mode === "username" ? (
                      <label>
                        新用户名
                        <input value={username} onChange={(e) => setName(e.target.value)} readOnly={busy} />
                      </label>
                    ) : (
                      <>
                        <label>
                          新密码
                          <input
                            type="password"
                            autoComplete="new-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            readOnly={busy}
                          />
                        </label>
                        <label>
                          确认新密码
                          <input
                            type="password"
                            autoComplete="new-password"
                            value={confirm}
                            onChange={(e) => setConfirm(e.target.value)}
                            readOnly={busy}
                          />
                        </label>
                        <p className="muted">8–128 个字符，不能与用户名相同，两次输入须一致。</p>
                      </>
                    )}
                    <p role="alert" className="auth-error">
                      {message}
                    </p>
                    <button className="button primary" disabled={busy || !currentPassword || !valid}>
                      保存
                    </button>
                  </form>
                )}
                <button className="button" disabled={busy} onClick={() => setMode(undefined)}>
                  取消
                </button>
              </section>
            </div>
          )}
        </>
      )}
    </>
  );
}

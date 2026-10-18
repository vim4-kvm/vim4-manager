import { useEffect, useState, type FormEvent } from "react";
import { request } from "./api";
import { logout, useAccount } from "./auth";

interface Device { id: string; address: string; userAgent: string; lastActive: string; current: boolean }
interface Account { username: string; passwordChanged: string; sessions: Device[] }
function deviceName(agent: string) {
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "未知浏览器";
  const os = /iPhone|iPad/.test(agent) ? "iOS" : /Android/.test(agent) ? "Android" : /Macintosh/.test(agent) ? "macOS" : /Windows/.test(agent) ? "Windows" : /Linux/.test(agent) ? "Linux" : "";
  return browser + (os ? ` · ${os}` : "");
}
function lastActive(value: string) { const minutes = Math.floor((Date.now() - Date.parse(value)) / 60000); return minutes < 1 ? "刚刚" : minutes < 60 ? `${minutes} 分钟前` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时前` : `${Math.floor(minutes / 1440)} 天前`; }
export function AccountRow() {
  const { username } = useAccount(); const [error, setError] = useState("");
  return <div className="account-foot"><a href="#/account" aria-label={`账户 ${username}`}><svg viewBox="0 0 24 24"><circle cx="12" cy="7" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/></svg><span>{username}</span></a><button className="button" onClick={() => logout().catch(e => setError(e.message))}>退出</button>{error && <span role="alert">{error}</span>}</div>;
}
export function AccountPanel() {
  const { setUsername } = useAccount();
  const [account, setAccount] = useState<Account>();
  const [mode, setMode] = useState<"password" | "username" | "others">();
  const [currentPassword, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [username, setName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function refresh() { const value = await request<Account>("/api/account/sessions"); setAccount(value); setUsername(value.username); }
  useEffect(() => { refresh().catch(e => setMessage(e.message)); }, []);
  function open(value: typeof mode) { setMode(value); setCurrent(""); setPassword(""); setConfirm(""); setName(account?.username || ""); setMessage(""); }
  async function run(action: () => Promise<unknown>, message: string) { setBusy(true); setMessage(""); try { await action(); setMode(undefined); setMessage(message); await refresh(); } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  async function submit(e: FormEvent) { e.preventDefault(); await run(() => request(`/api/account/${mode}`, { currentPassword, password, username }), mode === "password" ? "密码已修改，其他设备已退出" : "用户名已修改，其他设备已退出"); }
  const valid = mode === "username" ? /^[A-Za-z0-9._-]{1,32}$/.test(username) && username !== currentPassword : [...password].length >= 8 && [...password].length <= 128 && password !== account?.username && password === confirm;
  return <><p role="status">{message}</p>{account && <>
    <section className="card account-card"><h3>登录信息</h3><div className="account-info"><span>用户名　{account.username}</span><button className="button" onClick={() => open("username")}>修改用户名</button></div><div className="account-info"><span>密码　上次修改 {new Date(account.passwordChanged).toLocaleDateString()}</span><button className="button" onClick={() => open("password")}>修改密码</button></div></section>
    <section className="card account-card"><div className="account-info"><h3>登录设备　{account.sessions.length} 个</h3><button className="button" disabled={busy || account.sessions.length < 2} onClick={() => open("others")}>退出其他设备</button></div>
      {[...account.sessions].sort((a, b) => Number(b.current) - Number(a.current) || Date.parse(b.lastActive) - Date.parse(a.lastActive)).map(device => <div className="account-device" key={device.id}><span>{device.current && "● 本设备　"}{deviceName(device.userAgent)}</span><span className="muted">{device.address}{/^(127\.|::1$)/.test(device.address) && "(转发)"}　{lastActive(device.lastActive)}</span>{!device.current && <button className="button" disabled={busy} onClick={() => run(() => request("/api/account/revoke", { id: device.id }), "设备已退出")}>退出</button>}</div>)}
    </section>
    <section className="card account-card"><h3>说明</h3><p>当前账户保护管理面板；KVM 界面（8080）仍使用应用现有登录方式。MCP、VNC 等接口使用各自的密钥，在对应 KVM 界面中管理。</p><p>忘记密码：SSH 登录板子运行 <code>sudo vim4-manager set-password</code></p></section>
    {mode && <div className="auth-modal"><section className="card account-card" role="dialog" aria-modal="true" aria-label={mode === "others" ? "退出其他设备" : mode === "password" ? "修改密码" : "修改用户名"}>
      <h3>{mode === "others" ? "退出其他设备" : mode === "password" ? "修改密码" : "修改用户名"}</h3>
      {mode === "others" ? <><p>其他 {account.sessions.filter(d => !d.current).length} 个设备将退出，正在使用的 KVM 连接会断开。</p><button className="button" disabled={busy} onClick={() => run(() => request("/api/account/logout-others", {}), "其他设备已退出")}>确认退出</button></> : <form onSubmit={submit} className="account-form">
        <label>当前密码<input autoFocus type="password" autoComplete="current-password" value={currentPassword} onChange={e => setCurrent(e.target.value)} readOnly={busy}/></label>
        {mode === "username" ? <label>新用户名<input value={username} onChange={e => setName(e.target.value)} readOnly={busy}/></label> : <><label>新密码<input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} readOnly={busy}/></label><label>确认新密码<input type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} readOnly={busy}/></label><p className="muted">8–128 个字符，不能与用户名相同，两次输入须一致。</p></>}
        <p role="alert" className="auth-error">{message}</p><button className="button primary" disabled={busy || !currentPassword || !valid}>保存</button>
      </form>}<button className="button" disabled={busy} onClick={() => setMode(undefined)}>取消</button>
    </section></div>}
  </>}</>;
}

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { safeNext, type AuthState } from "./auth";
import { ThemeSwitch } from "./theme";
import "./styles.css";

function Login() {
  const [state, setState] = useState<AuthState>();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [visible, setVisible] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const passwordRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const next = safeNext(new URLSearchParams(location.search).get("next"));
  const setup = state && !state.configured;
  const passwordError = [...password].length < 8 || [...password].length > 128 ? "密码须为 8–128 个字符" : password === username ? "密码不能与用户名相同" : "";
  const confirmError = password !== confirm ? "两次密码不一致" : "";
  const usernameError = !/^[A-Za-z0-9._-]{1,32}$/.test(username) ? "用户名须为 1–32 个字母、数字、点、下划线或连字符" : "";
  useEffect(() => {
    fetch("/__vim4/api/auth/state").then(async r => {
      if (!r.ok) throw new Error(); const value: AuthState = await r.json();
      if (value.authenticated) { location.replace(next); return; }
      setState(value); setRetry(value.retryAfter);
    }).catch(() => setError("无法连接板子，请检查网络后重试"));
  }, [next]);
  useEffect(() => {
    if (!state) return;
    // Autofill can populate the DOM before React observes its change event.
    const frame = requestAnimationFrame(() => {
      if (document.activeElement !== document.body) return;
      if (usernameRef.current?.value && usernameRef.current.value !== "admin") passwordRef.current?.focus();
      else usernameRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [state]);
  useEffect(() => { if (retry <= 0) return; const timer = setTimeout(() => setRetry(retry - 1), 1000); return () => clearTimeout(timer); }, [retry]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const r = await fetch(`/__vim4/api/auth/${setup ? "setup" : "login"}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
      const data = await r.json();
      if (r.ok) { location.replace(next); return; }
      if (r.status === 429) setRetry(data.retryAfter);
      else if (r.status === 409) { setState({ ...state!, configured: true }); setError("账户已被设置，请登录"); }
      else setError(r.status === 503 ? "登录请求过多，请稍后再试" : r.status === 401 ? "用户名或密码错误" : data.error);
      setPassword(""); setTimeout(() => passwordRef.current?.focus(), 0);
    } catch { setError("无法连接板子，请检查网络后重试"); }
    finally { setBusy(false); }
  }
  return <div className="auth-shell"><div className="auth-card card">
    <div className="auth-brand"><span className="brand-icon">V4</span> VIM4 KVM</div>
    <h1>{setup ? "设置管理员账户" : "登录"}</h1>
    <p className="muted">{setup ? "该账户用于登录管理面板和所有 KVM 界面，KVM 应用原有的登录将停用。" : "登录后可使用管理面板和 KVM 界面"}</p>
    {setup && !state.setupAllowed ? <p>请在局域网内打开此页面完成首次设置，或通过 SSH 登录板子运行：<code>sudo vim4-manager set-password</code></p> : state && <form onSubmit={submit}>
      <label>用户名<input ref={usernameRef} autoComplete="username" value={username} readOnly={busy} onChange={e => setUsername(e.target.value)} onBlur={() => setTouched({ ...touched, username: true })} /></label>
      {setup && touched.username && <span className="auth-error">{usernameError}</span>}
      <label>密码<span className="password-field"><input ref={passwordRef} type={visible ? "text" : "password"} autoComplete={setup ? "new-password" : "current-password"} value={password} readOnly={busy} onChange={e => setPassword(e.target.value)} onBlur={() => setTouched({ ...touched, password: true })} /><button className="button" type="button" aria-label={visible ? "隐藏密码" : "显示密码"} onClick={() => setVisible(!visible)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button></span></label>
      {setup && <><span className={touched.password && passwordError ? "auth-error" : "muted"}>{touched.password && passwordError || "至少 8 个字符"}</span>
        <label>确认密码<input type="password" autoComplete="new-password" value={confirm} readOnly={busy} onChange={e => setConfirm(e.target.value)} onBlur={() => setTouched({ ...touched, confirm: true })} /></label>
        {touched.confirm && <span className="auth-error">{confirmError}</span>}</>}
      <div className="auth-error auth-message" role="status">{retry > 0 ? `尝试次数过多，请 ${retry} 秒后再试` : error}</div>
      <button className="button primary" disabled={busy || retry > 0 || (setup ? !!(passwordError || confirmError || usernameError) : !username || !password)}>{busy ? "正在登录…" : setup ? "创建并登录" : "登录"}</button>
    </form>}
    {!state && <p role="status">{error || "正在连接…"}</p>}
    {state && !state.secure && !state.setupAllowed && <p className="auth-warning">⚠ 此连接未加密，密码可能被窃听。外网访问请使用 HTTPS。</p>}
  </div><footer>{state?.hostname || location.hostname}<ThemeSwitch /></footer></div>;
}
createRoot(document.getElementById("root")!).render(<Login />);

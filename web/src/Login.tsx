import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import { safeNext, type AuthState } from "./auth";
import { copyText, Icon } from "./Icons";
import { ThemeSwitch } from "./theme";
import "./styles.css";

const connectionError = "无法连接板子，请检查网络后重试";
const resetCommand = "sudo vim4-manager set-password";

function passwordProblem(username: string, password: string) {
  if ([...password].length < 8 || [...password].length > 128) return "密码须为 8–128 个字符";
  if (password === username) return "密码不能与用户名相同";
  return "";
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="auth-message" role="alert">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6m0 3h.01" />
      </svg>
      <span>{message}</span>
    </div>
  );
}

function ResetCommand() {
  const [status, setStatus] = useState("");
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    try {
      await copyText(resetCommand);
      setStatus("已复制");
    } catch {
      setStatus("复制失败，请手动复制");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setStatus(""), 1500);
  }

  return (
    <div className="auth-command">
      <code>{resetCommand}</code>
      <button type="button" onClick={() => void copy()} aria-live="polite">
        {status || "复制"}
      </button>
    </div>
  );
}

function Login() {
  const [state, setState] = useState<AuthState>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [visible, setVisible] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [forgot, setForgot] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const next = safeNext(new URLSearchParams(location.search).get("next"));
  const setup = !!state && !state.configured;
  const hostname = state?.hostname || "VIM4 KVM";
  const usernameError = !username ? "请输入用户名" : setup && !/^[A-Za-z0-9._-]{1,32}$/.test(username)
    ? "用户名须为 1–32 个字母、数字、点、下划线或连字符" : "";
  const passwordError = !password ? "请输入密码" : setup ? passwordProblem(username, password) : "";
  const confirmError = setup && password !== confirm ? "两次密码不一致" : "";

  useEffect(() => {
    const controller = new AbortController();
    fetch("/__vim4/api/auth/state", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const value: AuthState = await response.json();
        if (controller.signal.aborted) return;
        if (value.authenticated) {
          location.replace(next);
          return;
        }
        setState(value);
        setRetry(value.retryAfter);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(connectionError);
      });
    return () => controller.abort();
  }, [next, loadAttempt]);

  useEffect(() => {
    document.title = `${setup ? "创建账户" : "登录"} · ${hostname} — VIM4 KVM`;
  }, [setup, hostname]);

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

  useEffect(() => {
    if (retry <= 0) return;
    const timer = setTimeout(() => setRetry(retry - 1), 1000);
    return () => clearTimeout(timer);
  }, [retry]);

  function edit(field: string) {
    setTouched((previous) => ({ ...previous, [field]: false }));
    setError("");
  }

  function blur(field: string) {
    if (setup) setTouched((previous) => ({ ...previous, [field]: true }));
  }

  function checkCapsLock(event: KeyboardEvent<HTMLInputElement>) {
    setCapsLock(event.getModifierState("CapsLock"));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || retry > 0 || !state || (setup && !state.setupAllowed)) return;
    setError("");
    setTouched({ username: true, password: true, confirm: true });
    if (usernameError || passwordError || confirmError) {
      (usernameError ? usernameRef : passwordError ? passwordRef : confirmRef).current?.focus();
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/__vim4/api/auth/${setup ? "setup" : "login"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (response.ok) {
        location.replace(next);
        return;
      }
      const data = await response.json();
      if (response.status === 429) {
        setRetry(Math.max(1, Number(data.retryAfter) || 1));
        setError("尝试次数过多，请稍后再试");
      } else if (response.status === 409) {
        setState({ ...state, configured: true });
        setTouched({});
        setConfirm("");
        setError("账户已被设置，请登录");
      } else {
        setError(response.status === 401 ? "用户名或密码错误"
          : response.status === 503 ? "登录请求过多，请稍后再试"
          : data.error || connectionError);
      }
      if (response.status === 401 || response.status === 409) {
        setPassword("");
        setTouched({});
        passwordRef.current?.focus();
      }
    } catch {
      setError(connectionError);
    }
    // Successful navigation keeps the form locked until the document is replaced.
    setBusy(false);
  }

  return (
    <main className="auth-shell">
      <header className="auth-identity">
        <span className="auth-logo">V4</span>
        {!state && !error ? (
          <span className="auth-skeleton auth-name-skeleton" />
        ) : (
          <h1>{hostname}</h1>
        )}
        <p>VIM4 KVM · {location.host}</p>
      </header>
      <section className="auth-card" aria-label={setup ? "创建管理员账户" : "设备登录"}>
        {!state ? (
          error ? (
            <div className="auth-load-error">
              <ErrorNotice message={error} />
              <button className="button" onClick={() => {
                setError("");
                setLoadAttempt((attempt) => attempt + 1);
              }}>
                重试
              </button>
            </div>
          ) : (
            <div className="auth-loading" role="status" aria-label="正在连接">
              <span className="auth-skeleton" />
              <span className="auth-skeleton" />
              <span className="auth-skeleton" />
            </div>
          )
        ) : setup && !state.setupAllowed ? (
          <div className="auth-setup">
            <h2>需要在局域网内完成设置</h2>
            <p>为防止他人抢先设置，首次设置只能在板子所在的局域网内进行。也可以 SSH 登录板子运行：</p>
            <ResetCommand />
          </div>
        ) : (
          <>
            {setup && (
              <div className="auth-setup">
                <h2>创建管理员账户</h2>
                <p>此账户用于登录管理面板和 KVM 界面。</p>
              </div>
            )}
            <form onSubmit={submit} noValidate>
              <div className="auth-field">
                <label htmlFor="username">用户名</label>
                <input
                  id="username"
                  ref={usernameRef}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={username}
                  readOnly={busy}
                  aria-invalid={!!(touched.username && usernameError)}
                  aria-describedby={touched.username && usernameError ? "username-error" : undefined}
                  onChange={(event) => {
                    setUsername(event.target.value);
                    edit("username");
                  }}
                  onBlur={() => blur("username")}
                />
                {touched.username && usernameError && <span id="username-error" className="auth-field-error">{usernameError}</span>}
              </div>
              <div className="auth-field">
                <label htmlFor="password">密码</label>
                <div className="password-field">
                  <input
                    id="password"
                    ref={passwordRef}
                    type={visible ? "text" : "password"}
                    autoComplete={setup ? "new-password" : "current-password"}
                    value={password}
                    readOnly={busy}
                    aria-invalid={!!(touched.password && passwordError)}
                    aria-describedby={setup || (touched.password && passwordError) ? "password-help" : undefined}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      edit("password");
                    }}
                    onFocus={() => setPasswordFocused(true)}
                    onBlur={() => {
                      setPasswordFocused(false);
                      setCapsLock(false);
                      blur("password");
                    }}
                    onKeyDown={checkCapsLock}
                    onKeyUp={checkCapsLock}
                  />
                  <button
                    className="button"
                    type="button"
                    aria-label={visible ? "隐藏密码" : "显示密码"}
                    onClick={() => setVisible(!visible)}
                  >
                    <Icon name={visible ? "eyeOff" : "eye"} />
                  </button>
                </div>
                {(setup || (touched.password && passwordError)) && (
                  <span id="password-help" className={touched.password && passwordError ? "auth-field-error" : "auth-hint"}>
                    {(touched.password && passwordError) || "至少 8 个字符"}
                  </span>
                )}
                {passwordFocused && capsLock && <span className="auth-caps" role="status">⇪ 大写锁定已开启</span>}
              </div>
              {setup && (
                <div className="auth-field">
                  <label htmlFor="confirm">确认密码</label>
                  <input
                    id="confirm"
                    ref={confirmRef}
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    readOnly={busy}
                    aria-invalid={!!(touched.confirm && confirmError)}
                    aria-describedby={touched.confirm && confirmError ? "confirm-error" : undefined}
                    onChange={(event) => {
                      setConfirm(event.target.value);
                      edit("confirm");
                    }}
                    onBlur={() => blur("confirm")}
                  />
                  {touched.confirm && confirmError && <span id="confirm-error" className="auth-field-error">{confirmError}</span>}
                </div>
              )}
              {error && <ErrorNotice message={error} />}
              <button
                className="button primary auth-submit"
                disabled={busy || retry > 0}
                aria-busy={busy}
              >
                {busy && <span className="spinner" aria-hidden="true" />}
                {busy ? "正在登录…" : retry > 0 ? `请 ${retry} 秒后再试` : setup ? "创建并登录" : "登录"}
              </button>
            </form>
            {!setup && (
              <div className="auth-recovery">
                <button
                  className="auth-forgot"
                  type="button"
                  aria-expanded={forgot}
                  aria-controls="password-recovery"
                  onClick={() => setForgot(!forgot)}
                >
                  忘记密码？
                </button>
                {forgot && (
                  <div id="password-recovery">
                    <p>忘记密码时，SSH 登录板子运行：</p>
                    <ResetCommand />
                    <p>所有已登录的设备会同时退出。</p>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </section>
      {state && !state.secure && !state.setupAllowed && (
        <p className="auth-warning">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="5" y="10" width="14" height="11" rx="2" />
            <path d="M9 10V6a4 4 0 0 1 8 0M12 14v3" />
          </svg>
          此连接未加密，密码可能被窃听。外网访问请使用 HTTPS。
        </p>
      )}
      <div className="auth-theme">
        <ThemeSwitch compact />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Login />);

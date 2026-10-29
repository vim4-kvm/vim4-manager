import { initializeLocale } from "./i18n";
import { Spinner } from "@/components/Spinner";
import { BrandMark } from "@/components/BrandMark";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import { safeNext, type AuthState } from "./auth";
import { useThemePreference } from "./theme";
import { copyText } from "./lib/clipboard";
import { Eye, EyeOff, LockKeyhole, LucideProvider } from "lucide-react";
import { LazyMotion, MotionConfig } from "motion/react";
import { InlineError } from "@/components/InlineError";
import { SettingsCard } from "@/components/SettingsCard";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapse } from "@/components/Motion";
import "./index.css";
import { t, useT } from "./i18n";
import { LanguageSwitch } from "./components/LanguageSwitch";

const errorMessages: Record<string, () => string> = {
  connection: () => t("common.connectionFailed"),
  attempts: () => t("login.tooManyAttempts"),
  configured: () => t("login.alreadyConfigured"),
  credentials: () => t("login.invalidCredentials"),
  busy: () => t("login.busy"),
};
const resetCommand = "sudo vim4-manager set-password";

function passwordProblem(username: string, password: string) {
  if ([...password].length < 8 || [...password].length > 128) return t("login.passwordRules");
  if (password === username) return t("login.passwordMatchesUsername");
  return "";
}

function ResetCommand() {
  const t = useT();
  const [status, setStatus] = useState("");
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    try {
      await copyText(resetCommand);
      setStatus(t("common.copied"));
    } catch {
      setStatus(t("common.copyFailed"));
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setStatus(""), 1500);
  }

  return (
    <div className="flex min-w-0 items-center justify-between gap-2 rounded-md border bg-muted p-3 text-xs [&_code]:min-w-0 [&_code]:break-all [&_code]:font-mono [&_button]:h-7 [&_button]:shrink-0 [&_button]:text-xs">
      <code>{resetCommand}</code>
      <Button variant="outline" type="button" onClick={() => void copy()} aria-live="polite">
        {status || t("common.copy")}
      </Button>
    </div>
  );
}

function Login() {
  const t = useT();
  useThemePreference();
  const [state, setState] = useState<AuthState>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [visible, setVisible] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const errorText = errorMessages[error]?.() ?? error;
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
  const usernameError = !username ? t("login.enterUsername") : setup && !/^[A-Za-z0-9._-]{1,32}$/.test(username)
    ? t("login.usernameRules") : "";
  const passwordError = !password ? t("login.enterPassword") : setup ? passwordProblem(username, password) : "";
  const confirmError = setup && password !== confirm ? t("login.passwordMismatch") : "";

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
        if (!controller.signal.aborted) setError("connection");
      });
    return () => controller.abort();
  }, [next, loadAttempt]);

  const pageTitle = t("login.pageTitle");
  useEffect(() => { document.title = pageTitle; }, [pageTitle]);

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
        setError("attempts");
      } else if (response.status === 409) {
        setState({ ...state, configured: true });
        setTouched({});
        setConfirm("");
        setError("configured");
      } else {
        setError(response.status === 401 ? "credentials"
          : response.status === 503 ? "busy"
          : data.error || "connection");
      }
      if (response.status === 401 || response.status === 409) {
        setPassword("");
        setTouched({});
        passwordRef.current?.focus();
      }
    } catch {
      setError("connection");
    }
    // Successful navigation keeps the form locked until the document is replaced.
    setBusy(false);
  }

  return (
    <main className="flex min-h-svh flex-col items-center gap-6 px-4 pt-[max(48px,20vh)] pb-8 max-[480px]:pt-[max(80px,12vh)]">
      <div className="absolute top-4 right-4"><LanguageSwitch login /></div>
      <header role="group" aria-label={t("common.device")} className="flex w-full max-w-[400px] flex-col items-center gap-2 text-center [&_h1]:text-xl [&_h1]:font-semibold [&_p]:text-sm [&_p]:text-muted-foreground">
        <BrandMark className="mb-2 size-11" />
        {!state && !error ? (
          <Skeleton className="h-7 w-36" />
        ) : (
          <h1>{hostname}</h1>
        )}
        <p>VIM4 KVM · {location.host}</p>
      </header>
      <SettingsCard className="w-full max-w-[400px]" title={setup ? undefined : t("login.signIn")} label={setup ? t("login.createAccount") : t("login.deviceSignIn")}>
        {!state ? (
          error ? (
            <div className="flex flex-col items-start gap-4">
              <InlineError>{errorText}</InlineError>
              <Button variant="outline" onClick={() => {
                setError("");
                setLoadAttempt((attempt) => attempt + 1);
              }}>
                {t("common.retry")}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-4" role="status" aria-label={t("common.connecting")}>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          )
        ) : setup && !state.setupAllowed ? (
          <div className="mb-5 space-y-3 text-sm text-muted-foreground [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-foreground">
            <h2>{t("login.lanRequired")}</h2>
            <p>{t("login.lanHelp")}</p>
            <ResetCommand />
          </div>
        ) : (
          <>
            {setup && (
              <div className="mb-5 space-y-3 text-sm text-muted-foreground [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-foreground">
                <h2>{t("login.createAccount")}</h2>
                <p>{t("login.accountHelp")}</p>
              </div>
            )}
            <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
              <div className="flex min-w-0 flex-col gap-2 text-sm">
                <label htmlFor="username">{t("login.username")}</label>
                <Input
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
                {(setup || (touched.username && usernameError)) && (
                  <span id="username-error" className="min-h-4 text-xs text-destructive">{touched.username && usernameError}</span>
                )}
              </div>
              <div className="flex min-w-0 flex-col gap-2 text-sm">
                <label htmlFor="password">{t("login.password")}</label>
                <div className="relative flex min-w-0 items-center [&_input]:pr-10">
                  <Input
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
                  <Button variant="ghost" size="icon"
                    className="absolute right-0 text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
                    type="button"
                    aria-label={visible ? t("login.hidePassword") : t("login.showPassword")}
                    onClick={() => setVisible(!visible)}
                  >
                    {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </Button>
                </div>
                {(setup || (touched.password && passwordError)) && (
                  <span id="password-help" className={touched.password && passwordError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                    {(touched.password && passwordError) || t("login.passwordHint")}
                  </span>
                )}
                {passwordFocused && capsLock && <span className="text-xs text-warning-foreground" role="status">{t("login.capsLock")}</span>}
              </div>
              {setup && (
                <div className="flex min-w-0 flex-col gap-2 text-sm">
                  <label htmlFor="confirm">{t("login.confirmPassword")}</label>
                  <Input
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
                  <span id="confirm-error" className="min-h-4 text-xs text-destructive">{touched.confirm && confirmError}</span>
                </div>
              )}
              {error && <InlineError>{errorText}</InlineError>}
              <Button variant="default"
                type="submit" className="mt-1 w-full"
                disabled={busy || retry > 0}
                aria-busy={busy}
              >
                {busy && <Spinner />}
                {busy ? t("login.signingIn") : retry > 0 ? t("login.retryAfter", { count: retry }) : setup ? t("login.createAndSignIn") : t("login.signIn")}
              </Button>
            </form>
            {!setup && (
              <div className="mt-4 flex flex-col gap-3 text-sm text-muted-foreground [&_p]:my-3">
                <Button variant="link" size="inline"
                  className="self-start"
                  type="button"
                  aria-expanded={forgot}
                  aria-controls="password-recovery"
                  onClick={() => setForgot(!forgot)}
                >
                  {t("login.forgotPassword")}
                </Button>
                <Collapse open={forgot}>
                  <div id="password-recovery">
                    <p>{t("login.recoveryHelp")}</p>
                    <ResetCommand />
                    <p>{t("login.recoverySessions")}</p>
                  </div>
                </Collapse>
              </div>
            )}
          </>
        )}
      </SettingsCard>
      {state && !state.secure && !state.setupAllowed && (
        <p className="flex w-full max-w-[400px] items-start gap-2 text-xs text-warning-foreground">
          <LockKeyhole className="size-4 shrink-0" aria-hidden="true" />
          {t("login.insecure")}
        </p>
      )}
    </main>
  );
}

await initializeLocale();
createRoot(document.getElementById("root")!).render(<MotionConfig reducedMotion="user"><LazyMotion features={() => import("@/lib/motion-dom").then((module) => module.default)} strict><LucideProvider strokeWidth={1.75}><Login /></LucideProvider></LazyMotion></MotionConfig>);

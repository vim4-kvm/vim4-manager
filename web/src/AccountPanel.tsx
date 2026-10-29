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
import { EmptyState } from "@/components/EmptyState";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingRow } from "@/components/SettingRow";
import { SettingsCard } from "@/components/SettingsCard";
import { PageHeading } from "@/components/PageHeading";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { t, useLocale } from "@/i18n";
import { dateTime, relativeTime } from "@/i18n/format";
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
type FieldMessage = "account.theCurrentPasswordIsIncorrect" | "account.enterYourCurrentPassword"
  | "account.useLettersNumbersPeriodsUnderscoresOr" | "account.theUsernameMustDifferFromThe"
  | "account.useCharactersForThePassword" | "account.thePasswordMustDifferFromThe" | "account.thePasswordsDonTMatch";
const RESET_COMMAND = "sudo vim4-manager set-password";
const kvmAuthNote = () => t("account.onceSignedInYouCanOpen");

function deviceInfo(agent: string) {
  const tool = agent.match(/curl|wget|python-requests|go-http-client|node-fetch|undici/i)?.[0];
  if (tool) return { name: t("account.commandLineTool", { p0: String(tool.toLowerCase()) }), icon: "terminal" };
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
    name: browser ? browser + (os ? ` · ${os}` : "") : t("account.unknownDevice"),
    icon: /iOS|Android/.test(os) ? "phone" : os ? "laptop" : "monitor",
  };
}

function addressInfo(address: string) {
  if (/^(127\.|::1$|0:0:0:0:0:0:0:1$)/i.test(address)) return { label: t("account.viaBoardProxy"), tailscale: false, proxied: true };
  const parts = address.split(".").map(Number);
  const tailscale =
    (parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || /^fd7a:115c:a1e0:/i.test(address);
  return { label: address, tailscale, proxied: false };
}

// Long session lists bury the row you are looking for; recent ones come first.
const DEVICE_PREVIEW = 5;

function lastActive(value: string) {
  const minutes = Math.floor((Date.now() - Date.parse(value)) / 60000);
  if (minutes < 1) return t("account.justNow");
  if (minutes < 60) return relativeTime(-minutes, "minute");
  if (minutes < 1440) return relativeTime(-Math.floor(minutes / 60), "hour");
  return relativeTime(-Math.floor(minutes / 1440), "day");
}

function localDate(value: string, time = false) {
  return dateTime(new Date(value), time ? { year: "numeric" } : { year: "numeric", hour: undefined, minute: undefined, second: undefined });
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
  return days === 0 ? t("account.today") : relativeTime(-days, "day");
}

export function AccountPanel() {
  const locale = useLocale();
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
  const [fields, setFields] = useState<Partial<Record<string, FieldMessage>>>({});
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
  }, [locale]);
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
        mode === "others" ? t("account.otherDevicesSignedOut") : mode === "password" ? t("account.passwordChanged") : t("account.usernameChanged"),
      );
      await refresh();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      if (text === t("account.theCurrentPasswordIsIncorrect")) setFields({ currentPassword: "account.theCurrentPasswordIsIncorrect" });
      else setError(text);
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const next: Partial<Record<string, FieldMessage>> = {};
    if (!currentPassword) next.currentPassword = "account.enterYourCurrentPassword";
    if (mode === "username") {
      if (!/^[A-Za-z0-9._-]{1,32}$/.test(username)) next.username = "account.useLettersNumbersPeriodsUnderscoresOr";
      else if (username === currentPassword) next.username = "account.theUsernameMustDifferFromThe";
    } else {
      if ([...password].length < 8 || [...password].length > 128) next.password = "account.useCharactersForThePassword";
      else if (password === account?.username) next.password = "account.thePasswordMustDifferFromThe";
      if (password !== confirm) next.confirm = "account.thePasswordsDonTMatch";
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
  const title = mode === "others" ? t("account.signOutOtherDevices") : mode === "password" ? t("account.changePassword") : t("account.changeUsername");
  const inputs = [
    {
      name: "currentPassword",
      label: t("account.currentPassword"),
      value: currentPassword,
      set: setCurrent,
      type: "password",
      complete: "current-password",
    },
    ...(mode === "username"
      ? [{ name: "username", label: t("account.newUsername"), value: username, set: setName, type: "text", complete: "username" }]
      : [
          {
            name: "password",
            label: t("account.newPassword"),
            value: password,
            set: setPassword,
            type: "password",
            complete: "new-password",
          },
          {
            name: "confirm",
            label: t("account.confirmNewPassword"),
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
          <Button variant="outline" aria-label={t("account.dismissMessage")} onClick={() => setMessage("")}>
            ×
          </Button>
        </div>
      )}
      <SettingsCard title={t("account.administratorAccount")}>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]">
          <div className="flex min-w-0 items-center gap-5 py-3 lg:border-r lg:pr-6">
            <Avatar username={signedInName} className="size-20 bg-chart-1/10 text-3xl text-chart-1" />
            <div className="min-w-0 space-y-1"><strong className="block break-all text-xl font-semibold">{signedInName}</strong><p className="text-sm text-muted-foreground">{t("account.deviceAdministrator")}</p></div>
          </div>
          <div className="@container min-w-0 divide-y [&>div]:py-4 [&>div:first-child]:pt-0 [&>div:last-child]:pb-0">
            <SettingRow title={t("login.username")} description={signedInName} control={<Button variant="outline" aria-label={t("account.changeUsername")} onClick={() => open("username")}>{t("account.changeUsername")}</Button>} />
            <SettingRow title={t("login.password")} description={<><span className="block tracking-widest text-foreground">••••••••</span><span>{account ? t("account.lastChanged", { p0: String(localDate(account.passwordChanged)), p1: String(passwordAge(account.passwordChanged)) }) : "—"}</span></>}
              control={<Button variant="outline" aria-label={t("account.changePassword")} disabled={!account} onClick={() => open("password")}>{t("account.changePassword")}</Button>} />
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
            <h3>{t("account.signedInDevices")}</h3>
            <p>{t("account.browsersAndToolsSignedInTo")}</p>
          </div>
          {account &&
            !loading &&
            !loadFailed &&
            (others ? (
              <Button variant="outline" disabled={busy || !!revoking.length} onClick={() => open("others")}>
                {t("account.signOutOtherDevices")}</Button>
            ) : (
              <span className="text-xs text-muted-foreground">{t("account.onlyThisDevice")}</span>
            ))}
        </div>
        <div className="min-w-0" role="table" aria-label={t("account.signedInDevices")} aria-busy={loading}>
          <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,180px)_100px_80px] items-center gap-3 rounded-md bg-muted/60 px-3 py-3 text-xs text-muted-foreground md:grid" role="row">
            <span role="columnheader">{t("account.device")}</span>
            <span role="columnheader">{t("account.address")}</span>
            <span role="columnheader">{t("account.lastActive")}</span>
            <span role="columnheader" aria-label={t("common.actions")} />
          </div>
          {loading ? (
            <PanelSkeleton label={t("account.loadingSignedInDevices")} />
          ) : loadFailed ? (
            <div className="flex flex-wrap items-center gap-3 py-4 text-sm text-destructive" role="alert">
              {t("account.couldnTLoadSignedInDevices")}{" "}
              <Button variant="link" size="inline" onClick={() => void refresh()}>
                {t("common.retry")}</Button>
            </div>
          ) : sessions.length === 0 ? (
            <EmptyState icon={Monitor}>{t("account.noDevices")}</EmptyState>
          ) : (
            <FadeIn><AnimatedList as="div" role="rowgroup" className="[&>*:last-child>[role=row]]:border-b-0 [&>*:last-child>[role=row]]:pb-0" items={allDevices ? sessions : sessions.slice(0, DEVICE_PREVIEW)} getKey={(device) => device.id}>{(device) => {
                const info = deviceInfo(device.userAgent);
                const address = addressInfo(device.address);
                return (
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-b px-3 py-5 text-sm md:grid-cols-[minmax(0,1fr)_minmax(0,180px)_100px_80px]" role="row" key={device.id}>
                    <span className="col-start-1 row-start-1 flex min-w-0 flex-wrap items-center gap-2 [&>span]:break-all" role="cell">
                      {info.icon === "terminal" ? <Terminal className="size-4 shrink-0" /> : info.icon === "phone" ? <Smartphone className="size-4 shrink-0" /> : info.icon === "laptop" ? <Laptop className="size-4 shrink-0" /> : <Monitor className="size-4 shrink-0" />}
                      <span>{info.name}</span>
                      {device.current && <Badge variant="outline" className="border-primary/30 text-primary">{t("account.thisDevice")}</Badge>}
                    </span>
                    <div className="col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-2 md:contents">
                      <span className="min-w-0 break-all text-xs text-muted-foreground md:col-start-2 md:row-start-1" role="cell">
                        <span className={address.proxied ? "" : "font-mono break-all"} title={address.proxied ? t("account.forwardedByAProxyOnThe") : undefined}>{address.label}</span>
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
                          {revoking.includes(device.id) ? t("account.signingOut") : t("account.signOut")}
                        </Button>
                      )}
                      {device.current && <span className="text-xs text-muted-foreground">{t("account.currentSession")}</span>}
                    </span>
                  </div>
                );
              }}</AnimatedList></FadeIn>
          )}
          {!loading && !loadFailed && sessions.length > DEVICE_PREVIEW && (
            <Button variant="link" size="inline" className="mt-3 text-xs" aria-expanded={allDevices} onClick={() => setAllDevices(!allDevices)}>
              {allDevices ? t("account.showRecentDevicesOnly") : t("account.showMoreDevices", { count: sessions.length - DEVICE_PREVIEW })}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t("account.signingOutADeviceEndsIts")}</p>
        <div className="flex justify-end border-t pt-4">
          <Button variant="outline" disabled={busy} onClick={async () => {
            setBusy(true);
            setError("");
            try { await logout(); } catch { setError(t("account.couldnTSignOutTryAgain")); setBusy(false); }
          }}>{busy && !mode ? t("account.signingOut") : t("account.signOutThisDevice")}</Button>
        </div>
      </div></SettingsCard>
      <div data-account-notes className="space-y-2 text-xs text-muted-foreground [&_code]:break-all [&_code]:font-mono">
        <p>
          {t("account.resetHelp", { command: RESET_COMMAND })} <Button variant="link" size="inline"
            className="ml-1 text-xs"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(RESET_COMMAND);
                setCopied(true);
              } catch {
                setError(t("account.couldnTCopyTheCommandCopy"));
              }
            }}
          >
            {copied ? t("common.copied") : t("account.copyCommand")}
          </Button>
        </p>
        <p>{kvmAuthNote()}</p>
      </div>
      {mode === "others" && <ConfirmDialog open title={title} description={t("account.signOutOthersHelp", { count: others })}
        confirm={busy ? t("account.signingOut") : t("account.signOutDevices")} busy={busy} closeOnConfirm={false}
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
                        setFields((value) => ({ ...value, [input.name]: undefined }));
                      }}
                    />
                    <span id={`${input.name}-error`} className="min-h-4 text-xs text-destructive">
                      {fields[input.name] && t(fields[input.name]!)}
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
                    {t("common.cancel")}</Button>
                  <Button variant="default" disabled={busy}>
                    {busy ? t("common.saving") : t("common.save")}
                  </Button>
                </div>
              </form>
        </div>
      </DetailsDialog>}
    </>
  );
}

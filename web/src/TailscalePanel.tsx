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
import { Network } from "lucide-react";
import { t, useLocale } from "@/i18n";

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

const JOB_LABEL: Record<string, string> = { get install() { return t("tailscale.installingTailscale"); }, get uninstall() { return t("tailscale.uninstallingTailscale"); } };
const CONTROL_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;

function accessURLs(state: TailscaleState) {
  const ip = state.ips?.find((a) => !a.includes(":"));
  const urls: { label: string; url: string }[] = [];
  if (ip) urls.push({ label: t("nav.apps"), url: `http://${ip}:8080` });
  if (state.dnsName) urls.push({ label: "MagicDNS", url: `http://${state.dnsName}:8080` });
  if (ip) urls.push({ label: t("nav.manager"), url: `http://${ip}` });
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
  const locale = useLocale();
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
  }, [pending, locale]);

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
    ? JOB_LABEL[job!.action] ?? t("tailscale.working64")
    : pending
      ? t("tailscale.working64")
      : stale
        ? t("wifi.statusUnavailable")
        : {
            absent: t("tailscale.notInstalled"),
            "daemon-off": t("tailscale.serviceStopped"),
            offline: t("tailscale.disconnected"),
            online: t("tailscale.connected"),
            approval: t("tailscale.awaitingApproval"),
            starting: t("wifi.connecting"),
            login: t("tailscale.signedOut"),
          }[current ?? "absent"];

  if (reading && !state) return <SettingsCard label="Tailscale"><PanelSkeleton label={label} /></SettingsCard>;

  return (
    <SettingsCard label="Tailscale"><FadeIn className="flex min-w-0 flex-col gap-5">
        <div className="flex items-start gap-4 [&_h3]:text-base [&_h3]:font-semibold"><div className="rounded-xl bg-muted p-3"><Network className="size-6" aria-hidden="true" /></div><div className="min-w-0 flex-1"><SettingRow title="Tailscale" description={t("tailscale.securelyAccessTheManagerAndKvm")}
          status={label} pending={jobRunning || !!pending}
          control={switchable && <Switch aria-label={t("tailscale.tailscaleConnection")} checked={connected} disabled={locked}
            onCheckedChange={() => connected ? setConfirming("down") : void act("up")} />} /></div></div>

        {state && !stale && current === "absent" && !jobRunning && (
          <div className="flex min-w-0 flex-col gap-4">
            <p className="text-muted-foreground">{t("tailscale.installsFromTailscaleSOfficialSigned")}</p>
            <div>
              <Button variant="default" disabled={locked} onClick={() => void act("install")}>
                {t("tailscale.installTailscale")}</Button>
            </div>
          </div>
        )}


        {state && (current === "login" || changing) && !jobRunning && (
          <div className="flex min-w-0 flex-col gap-4">
            <fieldset className="flex min-w-0 flex-col gap-3 text-sm [&_legend]:mb-2 [&_legend]:font-medium" disabled={locked}>
              <legend>{t("tailscale.controlServer")}</legend>
              <Segmented label={t("tailscale.controlServer")} className="max-sm:grid-cols-1">
                <SegmentedOption title={t("tailscale.tailscale")} detail="login.tailscale.com" pressed={!custom} onClick={() => setCustom(false)} />
                <SegmentedOption title={t("tailscale.custom")} detail={t("tailscale.headscaleOrACompatibleServer")} pressed={custom} onClick={() => setCustom(true)} />
              </Segmented>
              {custom && (
                <Input
                  aria-label={t("tailscale.controlServerUrl")}
                  placeholder="https://headscale.example.com"
                  value={control}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={!controlValid}
                  onChange={(e) => setControl(e.target.value)}
                />
              )}
              {custom && !controlValid && <span className="text-xs text-muted-foreground">{t("tailscale.enterOnlyTheProtocolDomainAnd")}</span>}
            </fieldset>
            {link ? (
              <div className="flex flex-col items-start gap-3">
                <span>{t("tailscale.openTheSignInPageAnd")}</span>
                <Button asChild variant="default"><a href={link} target="_blank" rel="noreferrer noopener">
                  {t("tailscale.openSignInPage")}</a></Button>
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
                  {t("tailscale.getSignInLink")}</Button>
              </div>
            )}
          </div>
        )}

        {state && current === "approval" && (
          <p className="flex min-w-0 flex-col gap-4 text-muted-foreground">{t("tailscale.signedInATailnetAdministratorNeeds")}</p>
        )}

        {state && (current === "online" || current === "offline") && (
          <FactGrid cols={2}>
            {state.tailnet && (
              <Fact label="Tailnet" value={state.tailnet} className="@md:col-span-2" />
            )}
            <Fact label={t("tailscale.controlServer")} value={state.controlURL || OFFICIAL_CONTROL} />
            <Fact label={t("tailscale.onlineDevices")} value={state.peersOnline != null && state.peers != null ? t("tailscaleDevices.onlineCount", { online: state.peersOnline, total: state.peers }) : t("common.unknown")} />
            {state.version && (
              <Fact label={t("tailscale.version")} value={state.version} />
            )}
            <Fact label={t("tailscale.accessUrls")} className="@md:col-span-2" value={<div className="flex flex-col gap-2 text-sm font-normal">
                {accessURLs(state).length ? (
                  <ul className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 rounded-lg bg-muted/50 p-3 [&_li]:contents">
                    {accessURLs(state).map(({ label, url }) => (
                      <li key={url}>
                        <span className="text-xs text-muted-foreground">{label}</span>
                        <a className="font-mono [overflow-wrap:anywhere]" href={url} target="_blank" rel="noreferrer noopener">
                          {url}
                        </a>
                        <span className="justify-self-start"><CopyButton text={url} label={t("tailscale.url", { p0: String(label) })} /></span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="font-mono break-all">—</span>
                )}
                <span className="text-xs text-muted-foreground">{t("tailscale.openFromADeviceOnThe")}</span>
              </div>} />
          </FactGrid>
        )}

        {connected && state?.devices && <TailscaleDevices devices={state.devices} writable={writable} />}

        {connected && (
          <p className="text-xs text-muted-foreground">
            {t("tailscale.theManagerAndKvmInterfaceShare")}</p>
        )}

        {state?.installed && !jobRunning && !stale && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {(current === "online" || current === "offline" || current === "approval") && (
              <Button variant="outline" disabled={locked} onClick={() => setChanging(!changing)}>
                {changing ? t("tailscale.cancelChange") : t("tailscale.changeControlServer")}
              </Button>
            )}
            {(current === "online" || current === "offline" || current === "approval") && (
              <Button variant="outline" disabled={locked} onClick={() => setConfirming("logout")}>
                {t("account.signOut")}</Button>
            )}
            <Button variant="destructive" disabled={locked} onClick={() => setConfirming("uninstall")}>
              {t("tailscale.uninstall")}</Button>
          </div>
        )}

        {confirming && (
          <ConfirmDialog open title={{ down: t("tailscale.disconnectTailscale"), login: t("tailscale.changeControlServer"), logout: t("tailscale.signOutOfTailscale"), uninstall: t("tailscale.uninstallTailscale") }[confirming]}
            description={confirming === "down" ? t("tailscale.remoteSessionsOverTailscaleWillDisconnect")
              : confirming === "login" ? t("tailscale.changeTheControlServerFromTo", { p0: String(state?.controlURL), p1: String(custom ? control.trim() : OFFICIAL_CONTROL) })
              : confirming === "logout" ? t("tailscale.thisDeviceWillLeaveTheTailnet")
              : t("tailscale.tailscaleWillStopAndItsPackage")}
            confirm={{ down: t("wifi.disconnect"), login: t("tailscale.changeServer"), logout: t("account.signOut"), uninstall: t("tailscale.uninstall") }[confirming]}
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

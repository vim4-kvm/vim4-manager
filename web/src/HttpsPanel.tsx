import { Fragment, useEffect, useId, useState, type ReactNode } from "react";
import { ChevronDown, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Fact, FactGrid } from "@/components/FactGrid";
import { Collapse, FadeIn } from "@/components/Motion";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingRow } from "@/components/SettingRow";
import { SettingsCard } from "@/components/SettingsCard";
import { Spinner } from "@/components/Spinner";
import { UrlList } from "@/components/UrlList";
import { retryTailscaleCert, setHttpEnabled, type HttpsState } from "@/api";
import { useLocale, useT } from "@/i18n";
import { date } from "@/i18n/format";
import { report } from "@/stores/action";
import { useHttpsStore } from "@/stores/https";
import { cn } from "@/lib/utils";

const POLL_MS = 5000;
const NAME_LIMIT = 4;
const TAILSCALE_DNS = "https://login.tailscale.com/admin/dns";
const RECOVERY_COMMAND = "sudo vim4-manager set-http on";
// Stands in for a rich placeholder value so the translated sentence can be split around it.
const SLOT = "\u0001";
const TRUST_STEPS = [["macOS", "https.trustMac"], ["iPhone / iPad", "https.trustIos"], ["Windows", "https.trustWindows"], ["Android", "https.trustAndroid"]] as const;
// Action buttons stack at full width on the narrowest phones.
const STACK = "max-[400px]:w-full";

function withNode(text: string, node: ReactNode) {
  const [before, after] = text.split(SLOT);
  return <>{before}{node}{after}</>;
}

/** The same page over HTTPS: same route, encrypted origin. */
function secureHref(https: HttpsState) {
  return `${https.urls.manager}/${location.hash}`;
}

export function HttpsPanel() {
  const t = useT();
  const locale = useLocale();
  const https = useHttpsStore((s) => s.https);
  const failed = useHttpsStore((s) => s.failed);
  const [saving, setSaving] = useState<boolean>();
  const [guard, setGuard] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [help, setHelp] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const helpId = useId();
  const switchId = useId();

  useEffect(() => {
    const { refresh } = useHttpsStore.getState();
    void refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [locale]);

  async function save(enabled: boolean) {
    setSaving(enabled);
    setGuard(false);
    setConfirming(false);
    try {
      useHttpsStore.getState().apply(await setHttpEnabled(enabled));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message === "https_required") setGuard(true);
      else report("critical", message);
    } finally {
      setSaving(undefined);
    }
  }

  function toggle(enabled: boolean) {
    if (enabled) return void save(true);
    // Only a page that already arrived over HTTPS proves it works before HTTP starts redirecting.
    if (!https?.request_secure) return setGuard(true);
    setConfirming(true);
  }

  async function retry() {
    setRetrying(true);
    try {
      await retryTailscaleCert();
      await useHttpsStore.getState().refresh();
    } catch (e) {
      report("critical", e instanceof Error ? e.message : String(e));
    } finally {
      setRetrying(false);
    }
  }

  const header = (
    <div className="flex items-start gap-4 [&_h3]:text-base [&_h3]:font-medium"><div className="rounded-xl bg-muted p-3"><Lock className="size-6" aria-hidden="true" /></div><div className="min-w-0 flex-1"><SettingRow title="HTTPS" description={t("https.description")}
      status={https ? t("https.on") : undefined} control={null} /></div></div>
  );

  // Also shown over cached facts: e.g. an HTTP tab left open after HTTP was turned off elsewhere can no longer
  // read; the facts below still carry the "Open over HTTPS" link.
  const loadError = failed && (
    <div className="flex flex-wrap items-center gap-3 text-sm text-destructive" role="alert">
      {t("https.loadFailed")}{" "}
      <Button variant="link" size="inline" onClick={() => void useHttpsStore.getState().refresh()}>{t("common.retry")}</Button>
    </div>
  );

  if (!https && !failed) return <SettingsCard label="HTTPS"><PanelSkeleton rows={4} /></SettingsCard>;
  if (!https) return (
    <SettingsCard label="HTTPS"><FadeIn className="flex min-w-0 flex-col gap-5">
      {header}
      {loadError}
    </FadeIn></SettingsCard>
  );

  const names = https.local.names.slice(0, NAME_LIMIT).join(" · ");
  const more = https.local.names.length - NAME_LIMIT;
  const tailscale = https.tailscale;
  const openOverHttps = <Button asChild variant="link" size="inline" className="text-xs"><a href={secureHref(https)}>{t("https.openOverHttps")}</a></Button>;

  return (
    <SettingsCard label="HTTPS">
      <FadeIn className="flex min-w-0 flex-col gap-5">
        {header}
        {loadError}
        <FactGrid cols={2}>
          <Fact label={t("tailscale.accessUrls")} className="@md:col-span-2" value={<div className="flex flex-col gap-2 text-sm font-normal">
            <UrlList rows={[{ label: t("nav.apps"), url: https.urls.kvm }, { label: t("nav.manager"), url: https.urls.manager }]} />
            {!https.request_secure && <span className="flex flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground">{t("https.onHttp")} {openOverHttps}</span>}
          </div>} />

          <Fact label={t("https.localCertificate")} value={t("https.localIssued", { date: date(new Date(https.local.not_after)) })}
            detail={more > 0 ? t("https.moreNames", { names, count: more }) : names}>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <Button asChild variant="outline" className={STACK}><a href="/__vim4/ca.crt" download="vim4-kvm-ca.crt">{t("https.downloadCa")}</a></Button>
              <Button variant="link" size="inline" aria-expanded={help} aria-controls={helpId} onClick={() => setHelp(!help)}>
                {t("https.howToTrust")}<ChevronDown aria-hidden="true" className={cn("transition-transform", help && "rotate-180")} />
              </Button>
            </div>
            <Collapse open={help}>
              <div id={helpId} className="mt-3 flex flex-col gap-3 rounded-lg bg-muted/50 p-4 text-sm">
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 max-sm:grid-cols-1">
                  {TRUST_STEPS.map(([platform, key]) => <div key={platform} className="col-span-full grid grid-cols-subgrid gap-y-0.5">
                    <dt className="font-medium">{platform}</dt>
                    <dd className="text-pretty text-muted-foreground">{t(key)}</dd>
                  </div>)}
                </dl>
                <p className="border-t pt-3 text-xs text-muted-foreground">{withNode(t("https.fingerprint", { fingerprint: SLOT }),
                  <span className="font-mono">{https.local.fingerprint_sha256.split(":").map((pair, i, all) => <Fragment key={i}>{pair}{i < all.length - 1 && <>:<wbr /></>}</Fragment>)}</span>)}</p>
              </div>
            </Collapse>
          </Fact>

          {tailscale.state !== "unavailable" && (
            <Fact label={t("https.tailscaleCertificate")} valueKey={tailscale.state}
              value={tailscale.state === "issued" ? <span className="font-mono font-normal">{tailscale.name}</span>
                : tailscale.state === "pending" ? <span className="flex items-center gap-1.5 font-normal text-muted-foreground"><Spinner />{t("https.requesting")}</span>
                : tailscale.state === "error" ? <span className="text-destructive">{t("https.requestFailed")}</span>
                : <span className="font-normal text-pretty">{t("https.tailscaleDisabled")}</span>}
              detail={tailscale.state === "issued" && tailscale.not_after ? t("https.tailscaleValid", { date: date(new Date(tailscale.not_after)) }) : undefined}>
              {tailscale.state === "disabled" && <div className="mt-2"><Button asChild variant="link" size="inline"><a href={TAILSCALE_DNS} target="_blank" rel="noreferrer noopener">{t("https.openTailscaleDns")}</a></Button></div>}
              {tailscale.state === "error" && tailscale.error && <p className="line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]" title={tailscale.error}>{tailscale.error}</p>}
              {tailscale.state === "error" && <div className="mt-3">
                <Button variant="outline" className={STACK} disabled={retrying || failed} aria-busy={retrying} onClick={() => void retry()}>
                  {retrying && <Spinner />}{t("common.retry")}</Button>
              </div>}
            </Fact>
          )}
        </FactGrid>
      </FadeIn>

      <div className="flex flex-col gap-3">
        {/* Unlike SettingRow, phones keep the switch on the title line instead of below the description. */}
        <div role="group" aria-labelledby={switchId} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1">
          <h3 id={switchId} className="text-sm font-medium">{t("https.keepHttp")}</h3>
          <div className="col-start-2 row-start-1 flex sm:row-span-2">
            <Switch aria-label={t("https.keepHttp")} checked={saving ?? https.http_enabled} disabled={saving !== undefined || failed} onCheckedChange={toggle} />
          </div>
          <p className="col-span-full text-sm text-pretty text-muted-foreground sm:col-span-1">{t("https.keepHttpHelp")}</p>
        </div>
        {guard && !https.request_secure && (
          <p role="status" className="flex flex-wrap items-baseline gap-x-1.5 text-xs text-warning-foreground">{t("https.openHttpsFirst")} {openOverHttps}</p>
        )}
        <ConfirmDialog open={confirming} title={t("https.turnOffTitle")}
          description={withNode(t("https.turnOffBody", { command: SLOT }), <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs whitespace-nowrap text-foreground">{RECOVERY_COMMAND}</code>)}
          confirm={t("https.turnOff")} destructive onOpenChange={setConfirming} onConfirm={() => void save(false)} />
      </div>
    </SettingsCard>
  );
}

import { FadeIn } from "@/components/Motion";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { InlineError } from "@/components/InlineError";
import { EmptyState } from "@/components/EmptyState";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingsCard } from "@/components/SettingsCard";
import { StatusLabel, type Tone } from "@/components/StatusDot";
import { useActionStore } from "@/stores/action";
import { useStatusStore } from "@/stores/status";
import { useCallback, useEffect, useState } from "react";
import { getUpdates, installUpdate, type Update } from "./api";
import { DevelopmentBadge } from "@/components/DevelopmentBadge";
import { isDevelopmentVersion } from "@/lib/version";
import { PageHeading } from "@/components/PageHeading";
import { KernelPanel } from "@/KernelPanel";
import { ExternalLink, RefreshCw, PackageOpen } from "lucide-react";
import { t, useLocale } from "@/i18n";
import { time } from "@/i18n/format";


// NanoKVM, JetKVM and One-KVM install updates from their own settings page,
// which is only reachable while that application is the running one.
const SELF_SERVICE: Record<string, string> = { "vim4-nanokvm": "nanokvm", "vim4-jetkvm": "jetkvm", "vim4-onekvm": "onekvm" };

function state(update: Update): { tone: Tone; label: string } {
  if (!update.installed) return { tone: "idle", label: t("tailscale.notInstalled") };
  if (update.error) return { tone: "warning", label: update.error };
  if (update.available) return { tone: "warning", label: t("updates.updateTo", { p0: String(update.latest) }) };
  if (isDevelopmentVersion(update.installed)) return { tone: "idle", label: t("updates.noNewerStableRelease") };
  // Not offered but different: a local build at or past the newest release.
  if (update.latest && update.installed !== update.latest) return { tone: "good", label: t("updates.newerThanLatestRelease") };
  return { tone: "good", label: t("updates.upToDate") };
}

export function UpdatesPanel() {
  const locale = useLocale();
  const busy = useActionStore((s) => !!s.busy);
  const run = useActionStore((s) => s.run);
  const active = useStatusStore((s) => s.status?.active);
  const [updates, setUpdates] = useState<Update[]>();
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState<string>();
  const [checkedAt, setCheckedAt] = useState<number>();

  const check = useCallback(async (signal?: AbortSignal) => {
    setChecking(true);
    try {
      const next = await getUpdates(signal);
      if (!signal?.aborted) { setUpdates(next); setError(undefined); setCheckedAt(Date.now()); }
    } catch (e) {
      if (!signal?.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!signal?.aborted) setChecking(false);
    }
  }, []);

  useEffect(() => {
    // Releases change rarely; check on open and after each installation.
    if (busy) return;
    const controller = new AbortController();
    void check(controller.signal);
    return () => controller.abort();
  }, [busy, check, locale]);

  const install = (update: Update) => {
    setConfirming(undefined);
    void run(t("updates.downloadingAndInstalling", { p0: String(update.name), p1: String(update.latest) }), () => installUpdate(update.package),
      t(update.package === "vim4-manager" ? "updates.managerUpdated" : "updates.componentUpdated", { name: update.name, version: update.latest || "" }));
  };

  return (
    <>
      <PageHeading page="updates" action={
        <Button variant="outline" disabled={busy || checking} onClick={() => void check()}><RefreshCw className={checking ? "motion-safe:animate-spin" : undefined} />
          {checking ? t("updates.checking") : t("updates.checkAgain")}
        </Button>
      } />
      <SettingsCard label={t("updates.kernel")} title={t("updates.runningKernel")}><KernelPanel /></SettingsCard>
      <SettingsCard label={t("updates.update")} title={t("updates.softwareComponents")} description={t("updates.checksEachProjectSLatestGithub")} flush>
      <div className="p-4 sm:p-6">
      {error && <InlineError>{t("updates.checkFailed", { reason: error })}</InlineError>}
      {!updates ? (
        !error && <PanelSkeleton />
      ) : updates.length === 0 ? (
        <EmptyState icon={PackageOpen}>{t("updates.noComponents")}</EmptyState>
      ) : (
        <FadeIn className="min-w-0 overflow-auto"><table className="w-full text-left text-sm [&_th]:bg-muted/60 [&_th]:px-3 [&_th]:py-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground [&_td]:border-b [&_td]:px-3 [&_td]:py-4 [&_td]:align-middle [&_tr:last-child_td]:border-b-0 max-md:block max-md:[&_tbody]:block max-md:[&_thead]:block max-md:[&_tr]:grid max-md:[&_tr]:grid-cols-2 max-md:[&_td]:min-w-0 max-md:[&_td]:border-b-0 max-md:[&_tbody_tr]:border-b max-md:[&_tbody_tr:last-child]:border-b-0">
          <thead>
            <tr>
              <th>{t("updates.component")}</th>
              <th className="hidden md:table-cell">{t("updates.installed")}</th>
              <th className="hidden xl:table-cell">{t("updates.latestVersion")}</th>
              <th>{t("updates.status")}</th>
              <th className="hidden md:table-cell" aria-label={t("common.actions")} />
            </tr>
          </thead>
          <tbody>
            {updates.map((update) => {
              const { tone, label } = state(update);
              return (
                <tr key={update.package}>
                  <td>
                    <span className="flex flex-wrap items-center gap-2 font-medium">{update.name}<DevelopmentBadge version={update.installed} /></span>
                    <a className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-link hover:underline" href={`https://github.com/vim4-kvm/${update.repo}/releases`} target="_blank" rel="noreferrer"
                      aria-label={t("updates.githubReleasesFor", { p0: String(update.name), p1: String(update.repo) })}>
                      {t("updates.releases")}<ExternalLink aria-hidden="true" className="size-3" />
                    </a>
                  </td>
                  <td className="font-mono break-all text-muted-foreground hidden md:table-cell text-xs">{update.installed || "—"}</td>
                  <td className="hidden break-all font-mono text-xs text-muted-foreground xl:table-cell">{update.latest || "—"}</td>
                  <td>
                    <StatusLabel tone={tone}>
                      {label}
                    </StatusLabel>
                    {update.available && update.selfService && active !== SELF_SERVICE[update.package] && (
                      <span className="text-muted-foreground mt-1 block text-xs">{t("updates.selfServiceHelp", { name: update.name })}</span>
                    )}
                  </td>
                  <td className="text-right max-md:col-span-2 max-md:pt-0">
                    {update.available && update.selfService && active === SELF_SERVICE[update.package] && (
                      <Button asChild variant="outline"><a href={`${location.protocol}//${location.hostname}:8080/?kvm=${active}`}>
                        {t("updates.selfServiceAction", { name: update.name })}</a></Button>
                    )}
                    {update.available && !update.selfService && (
                      confirming === update.package ? (
                        <ConfirmDialog open title={t("updates.update211", { p0: String(update.name) })} confirm={t("updates.update")} disabled={busy}
                          description={update.package === "vim4-pikvm" ? t("updates.pikvmWillRestartIfItIs") : t("updates.theManagerWillRestart")}
                          onOpenChange={(open) => { if (!open) setConfirming(undefined); }} onConfirm={() => install(update)} />
                      ) : (
                        <Button variant="default" disabled={busy} onClick={() => setConfirming(update.package)}>
                          {t("updates.update")}</Button>
                      )
                    )}
                    {!update.available && update.selfService && <span className="text-xs text-muted-foreground">{t("updates.updateInKvm")}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></FadeIn>
      )}
      </div>
      </SettingsCard>
      <div className="flex flex-wrap justify-between gap-3 text-xs text-muted-foreground"><span>{checkedAt ? t("updates.checkedAt", { time: time(checkedAt) }) : t("updates.notCheckedYet")}</span><a className="text-link hover:underline" href="#/overview">{t("updates.viewDeviceAndVersions")}</a></div>
    </>
  );
}

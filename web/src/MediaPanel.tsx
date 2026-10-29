import { number } from "@/i18n/format";
import { t } from "@/i18n";
import { Checkbox } from "@/components/ui/checkbox";
import { FadeIn } from "@/components/Motion";
import { AnimatedList } from "@/components/AnimatedList";
import { useEffect, useState } from "react";
import { useLocale } from "@/i18n";
import { request, type Media, type MediaImage } from "./api";
import { Disc3, ExternalLink, HardDrive, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingRow } from "@/components/SettingRow";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { InlineError } from "@/components/InlineError";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingsCard } from "@/components/SettingsCard";
import { StatusLabel } from "@/components/StatusDot";
import { PageHeading } from "@/components/PageHeading";
import { kvmURL } from "@/lib/units";
import { useActionStore } from "@/stores/action";
import { useStatusStore } from "@/stores/status";

const sources: Record<string, string> = { get data() { return t("nav.disks"); }, get shared() { return t("media.nanokvmImages"); }, jetkvm: "JetKVM", onekvm: "One-KVM", pikvm: "PiKVM" };
type Run = (label: string, action: () => Promise<unknown>, done: string) => Promise<boolean>;

export function needsMediaEject(media: Media | undefined, target: string): boolean {
  return !!media?.inserted && (target === "pikvm" || media.pikvm);
}

export function mediaName(media: Media): string {
  const nas = media.nasdisk;
  return nas ? `${nas.storageName} › ${nas.path === "/" ? t("nasDisk.rootFolder") : nas.path.replace(/^\//, "")}` : media.name;
}

function size(bytes: number): string {
  return bytes >= 2 ** 30 ? `${number(bytes / 2 ** 30, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GiB` : `${number(bytes / 2 ** 20, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MiB`;
}

function MediaIcon({ cdrom, empty }: { cdrom?: boolean; empty?: boolean }) {
  const Icon = cdrom ? Disc3 : HardDrive;
  return <Icon aria-hidden="true" className={`size-4 shrink-0 ${empty ? "text-muted-foreground" : "text-primary"}`} />;
}

function MediaFacts({ media }: { media: Media }) {
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs">
      <span className="rounded-md border px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground">{media.nasdisk ? t("media.nasFolder") : media.cdrom ? t("media.virtualDisc") : t("media.virtualDisk")}</span>
      <span className="rounded-md border px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground">{media.readOnly ? t("nasDisk.readOnly") : t("nasDisk.writable")}</span>
      <StatusLabel tone={media.connected ? "good" : "warning"}>
        {media.connected ? t("media.usbConnected") : t("media.usbDisconnected")}
      </StatusLabel>
    </span>
  );
}

function HostEject() { useLocale(); return t("media.safelyEjectThisMediaOnThe"); }
export const hostEject = <HostEject />;

export function MediaSummary({ media }: { media?: Media }) {
  if (media?.known && !media.inserted) return null;
  return (
    <a className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4 shadow-xs dark:shadow-none" href="#/media">
      {media?.known ? (
        <>
          <MediaIcon cdrom={media.cdrom} />
          <span className="flex min-w-0 flex-1 flex-col gap-1 [overflow-wrap:anywhere]">
            <strong>{mediaName(media)}</strong>
            <MediaFacts media={media} />
          </span>
        </>
      ) : (
        <>
          <MediaIcon empty />
          <span className="flex min-w-0 flex-1 flex-col gap-1 [overflow-wrap:anywhere]">
            <strong>{t("media.couldnTReadVirtualMediaStatus")}</strong>
            <span className="text-sm text-muted-foreground">{t("media.waitForStatusToRecoverBefore")}</span>
          </span>
        </>
      )}
      <span className="ml-auto text-xs text-link">{t("media.manageMedia")}</span>
    </a>
  );
}

export function MediaWait({ media, target, onCancel }: { media?: Media; target: string; onCancel: () => void }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4" role="status">
      <div className="flex flex-wrap items-center gap-3">
        <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
        <strong>{t("media.waitTarget", { target })}</strong>
        <Button variant="outline" onClick={onCancel}>
          {t("media.cancelWait")}</Button>
      </div>
      {media?.inserted && (
        <p>
          {t("media.waitMounted", { name: mediaName(media) })}</p>
      )}
      <p className="text-sm text-muted-foreground">{hostEject}</p>
      <p className="text-sm text-muted-foreground">{t("media.waitsUpToFiveMinutesLeaving")}</p>
    </div>
  );
}

function CurrentMedia({ media, locked, run }: { media?: Media; locked: boolean; run: Run }) {
  const [ejecting, setEjecting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    setEjecting(false);
    setConfirmed(false);
  }, [media?.token, media?.inserted, media?.known]);

  if (!media?.known) {
    return (
      <SettingsCard title={t("media.currentMedia")}>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex size-20 items-center justify-center rounded-full bg-muted"><HardDrive className="size-10 text-muted-foreground" aria-hidden="true" /></div>
          <div className="flex min-w-0 flex-1 flex-col gap-1 [overflow-wrap:anywhere]">
            <h3 className="text-sm font-medium">{t("media.statusUnknown")}</h3>
            <p className="text-sm text-muted-foreground">{t("media.couldnTReadMediaStatusWait")}</p>
          </div>
        </div>
      </SettingsCard>
    );
  }
  if (!media.inserted) {
    return (
      <SettingsCard title={t("media.currentMedia")}>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex size-20 items-center justify-center rounded-full bg-muted"><Disc3 className="size-12 text-muted-foreground" aria-hidden="true" /></div>
          <div className="flex min-w-0 flex-1 flex-col gap-1 [overflow-wrap:anywhere]">
            <h3 className="text-sm font-medium">{t("media.noMediaMounted")}</h3>
            <p className="text-sm text-muted-foreground">{t("media.chooseAnImageFromTheLibrary")}</p>
          </div>
        </div>
      </SettingsCard>
    );
  }
  return (
    <SettingsCard title={t("media.currentMedia")}>
      <div className="flex flex-wrap items-center gap-5 py-2">
        <div className="flex size-24 shrink-0 items-center justify-center rounded-full border-8 border-muted bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-300">{media.cdrom ? <Disc3 className="size-16" aria-hidden="true" /> : <HardDrive className="size-12" aria-hidden="true" />}</div>
        <div className="flex min-w-0 flex-1 basis-48 flex-col gap-3 [overflow-wrap:anywhere]">
          <h3 className="text-xl font-semibold tracking-tight">{mediaName(media)}</h3>
          <StatusLabel tone="good">{t("disk.mountedOnHost")}</StatusLabel>
          <MediaFacts media={media} />
          {media.nasdisk?.mode === "rw" && <p className="text-sm text-muted-foreground">{t("media.ejectingWritesChangesBackToThe")}</p>}
        </div>
        <div className="flex max-w-sm flex-col items-end gap-5">
        {!ejecting && (
          <Button variant="outline" disabled={locked} onClick={() => setEjecting(true)}>
            {t("media.eject")}</Button>
        )}
        <p className="text-xs text-muted-foreground">{t("media.safelyEjectMediaOnTheHost")}</p>
        </div>
      </div>
      <ConfirmDialog open={ejecting} onOpenChange={setEjecting} title={t("media.eject")} confirm={t("media.ejectVirtualDisk")}
        busy={locked} disabled={!confirmed || !media.token} closeOnConfirm={false}
        onConfirm={() => {
          setConfirmed(false);
          void run(t("media.ejectingVirtualDisk"), () => request("/api/media/eject", { token: media.token, confirmed: true }), t("media.virtualDiskEjected"));
        }}>
        <ol className="list-inside list-decimal space-y-2 text-sm text-muted-foreground">
          <li>{hostEject}</li><li>{t("media.confirmThatTheHostHasStopped")}</li>
        </ol>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox className="mt-0.5" checked={confirmed} disabled={locked} onCheckedChange={(value) => setConfirmed(value === true)} />
          {t("media.theHostHasStoppedUsingThe")}</label>
        <p className="text-sm text-muted-foreground">{t("media.thisDoesnTReplaceSafeRemoval")}</p>
      </ConfirmDialog>
    </SettingsCard>
  );
}

export function MediaPanel() {
  const locale = useLocale();
  const status = useStatusStore((s) => s.status);
  const stale = useStatusStore((s) => s.stale);
  const media = stale ? undefined : status?.media;
  const active = status?.active ?? "";
  const activeApp = status?.apps.find((a) => a.id === active);
  const activeName = activeApp?.name;
  const busy = useActionStore((s) => !!s.busy);
  const run = useActionStore((s) => s.run);
  const [images, setImages] = useState<MediaImage[]>([]);
  const [imageID, setImageID] = useState("");
  const [readonly, setReadonly] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    request<MediaImage[]>("/api/media", undefined, controller.signal).then(setImages).catch(e => {
      if (!controller.signal.aborted) { setImages([]); setError(e.message); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload, locale]);
  const selected = images.find(image => image.id === imageID);
  const locked = busy || !media?.known;
  const readOnlyRequired = !!selected?.cdrom || active === "jetkvm";
  const groups = [...new Set(images.map(image => image.source))]
    .sort((a, b) => Object.keys(sources).indexOf(a) - Object.keys(sources).indexOf(b));
  const blocker = media?.inserted ? t("media.ejectTheCurrentMediaBeforeMounting")
    : !activeName ? t("media.enableAKvmInterfaceBeforeMounting")
    : !selected ? t("media.chooseAnImage")
    : t("media.mountThroughUsbInputMayReconnect", { p0: String(activeName) });

  return (
    <>
      <PageHeading page="media" />
      <CurrentMedia media={media} locked={locked} run={run} />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_250px]">
      <SettingsCard title={t("media.imageLibrary")} action={<div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || loading} onClick={() => setReload(value => value + 1)}><RefreshCw />{t("disk.refresh")}</Button><Button variant="outline" asChild><a href="#/disks">{t("media.manageDataDisks")}<ExternalLink /></a></Button></div>}>
        {loading ? <PanelSkeleton />
          : error ? <InlineError>{error}</InlineError>
          : images.length === 0 ? (
            <EmptyState icon={Disc3}>{t("media.noImagesYetCreateAData")}</EmptyState>
          ) : (
            <FadeIn><div className="flex flex-col gap-5" role="radiogroup" aria-label={t("media.imageFile")}>
              {groups.map(source => (
                <div key={source} className="flex flex-col gap-2 [&_h4]:flex [&_h4]:items-baseline [&_h4]:justify-between [&_h4]:text-xs [&_h4]:font-medium [&_h4]:text-muted-foreground">
                  <h4>
                    {sources[source] ?? source}
                    {source === "data" && <a className="text-xs text-link hover:underline" href="#/disks">{t("media.manageFiles")}</a>}
                  </h4>
                  <AnimatedList className="flex flex-col divide-y" items={images.filter(image => image.source === source)} getKey={(image) => image.id}>{(image) => (
                    <label className="flex min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 py-4 transition-colors hover:bg-accent/60 has-checked:bg-chart-1/7 has-disabled:cursor-default has-disabled:hover:bg-transparent [&_input]:accent-chart-1">
                      <input
                        type="radio"
                        name="media-image"
                        value={image.id}
                        checked={image.id === imageID}
                        disabled={locked}
                        onChange={() => { setImageID(image.id); setReadonly(true); }}
                      />
                      <span className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 md:grid-cols-[minmax(0,1fr)_6rem_4rem]">
                        <span className="flex min-w-0 items-center gap-3"><MediaIcon cdrom={image.cdrom} /><span className="min-w-0 break-all text-sm font-medium">{image.name}</span></span>
                        <span className="text-right text-xs tabular-nums text-muted-foreground">{size(image.size)}</span>
                        <span className="hidden text-right text-xs text-muted-foreground md:block">{image.cdrom ? t("media.disc") : t("media.disk")}</span>
                      </span>
                    </label>
                  )}</AnimatedList>
                </div>
              ))}
            </div></FadeIn>
          )}
        <SettingRow title={selected ? t("media.selected", { p0: String(selected.name) }) : t("media.selectImage")} description={blocker} control={<>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox className="mt-0.5"
              checked={readonly || readOnlyRequired}
              disabled={locked || !!media?.inserted || readOnlyRequired}
              onCheckedChange={(value) => setReadonly(value === true)}
            />
            {t(readOnlyRequired ? "media.mountReadOnlyRequired" : "media.mountReadOnly")}
          </label>
          <Button variant="default" aria-label={t("media.mountImage")}
            disabled={locked || loading || !!media?.inserted || !selected || !active}
            onClick={() => {
              if (selected) void run(t("media.mountingVirtualDisk"), () => request("/api/media/mount", { app: active, image: selected.id, cdrom: selected.cdrom, readOnly: readonly || readOnlyRequired }), t("media.virtualDiskMounted"));
            }}
          >
            {media?.inserted ? t("media.ejectCurrentMedia") : t("media.mountImage")}
          </Button>
        </>} />
      </SettingsCard>
      <SettingsCard title={t("media.imageSource")}>
        <div className="space-y-4 text-sm text-muted-foreground">
          <p><strong className="font-medium text-foreground">{t("nav.disks")}</strong>{t("media.createImagesAndManageFilesOn")}</p>
          <p><strong className="font-medium text-foreground">ISO / IMG</strong>{t("media.uploadThroughTheCorrespondingKvmInterface")}</p>
          {activeApp && <a className="inline-flex items-center gap-1 text-link hover:underline" href={kvmURL(activeApp.port, activeApp.id)}>{t("media.openInterface", { name: activeApp.name })}<ExternalLink className="size-3.5" /></a>}
        </div>
        <p className="text-xs text-muted-foreground">{t("media.allFourInterfacesShareOneUsb")}</p>
      </SettingsCard>
      </div>
    </>
  );
}

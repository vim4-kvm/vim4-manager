import { t, useLocale, getLocale } from "@/i18n";
import { number, dateTime } from "@/i18n/format";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/Spinner";
import { FadeIn } from "@/components/Motion";
import { AnimatedList } from "@/components/AnimatedList";
import { FileColumns } from "@/components/FileColumns";
import { FileActions } from "@/components/FileActions";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExternalLink, File, Folder, FolderPlus, HardDrive, MoreHorizontal, Plus, RefreshCw, Upload } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { InlineError } from "@/components/InlineError";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingRow } from "@/components/SettingRow";
import { SettingsCard } from "@/components/SettingsCard";
import { PageHeading } from "@/components/PageHeading";
import { DetailsDialog } from "@/components/DetailsDialog";
import { StatusLabel } from "@/components/StatusDot";
import { useActionStore, report } from "@/stores/action";
import { useStatusStore } from "@/stores/status";
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  diskFileURL, diskImageURL, getDisks, listDiskFiles, request, uploadDiskFile,
  type Disk, type DiskEntry, type DiskListing,
} from "./api";

type Run = (label: string, action: () => Promise<unknown>, done: string) => Promise<boolean>;
type Report = (tone: "good" | "critical", text: string) => void;

// FAT32 cannot store a file of 4 GiB or more.
const FAT_FILE_LIMIT = 2 ** 32 - 1;
const SIZES = [256, 1024, 4096, 16384];
const GROW_SIZES = [512, 1024, 2048, 4096, 8192, 16384, 32768];
const leaveUpload = () => t("disk.anUploadIsInProgressLeaving");

export function bytes(value: number): string {
  const decimal = (v: number) => number(v, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (value >= 2 ** 40) return `${decimal(value / 2 ** 40)} TiB`;
  if (value >= 2 ** 30) return `${decimal(value / 2 ** 30)} GiB`;
  if (value >= 2 ** 20) return `${decimal(value / 2 ** 20)} MiB`;
  if (value >= 2 ** 10) return `${number(value / 2 ** 10, { maximumFractionDigits: 0 })} KiB`;
  return `${number(value)} B`;
}

function when(seconds: number): string {
  return dateTime(seconds * 1000, { year: "numeric", second: undefined });
}

const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);
const parent = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const validName = (name: string) => !!name && name !== "." && name !== ".." && !/[\\/:*?"<>|\x00-\x1f\x7f-\x9f]/.test(name) && name.length <= 255;
export const normalizeLabel = (label: string) => label.toUpperCase().replace(/[^A-Z0-9 _-]/g, "").slice(0, 11);

function DiskIcon() { return <HardDrive aria-hidden="true" className="size-4 shrink-0 text-primary" />; }
function FileIcon({ dir }: { dir: boolean }) {
  const Icon = dir ? Folder : File;
  return <Icon aria-hidden="true" className={`size-4 shrink-0 ${dir ? "fill-amber-400/20 text-amber-500" : "text-muted-foreground"}`} />;
}

// Shows progress on the button that started an action, not only in the page banner.
function useTracked(run: Run) {
  const [doing, setDoing] = useState<string>();
  const track = (key: string): Run => (label, action, done) => {
    setDoing(key);
    return run(label, action, done).finally(() => setDoing(undefined));
  };
  return { doing, track };
}

function Action({ working, className, children, ...props }: React.ComponentProps<typeof Button> & { working?: boolean }) {
  return (
    <Button variant="outline" className={className} aria-busy={working || undefined} {...props}>
      {working && <Spinner />}
      {children}
    </Button>
  );
}

// Destructive actions require an explicit confirmation without a time limit.
function ArmedButton({ label, armedLabel, ariaLabel, disabled, working, onConfirm }: {
  label: string; armedLabel: string; ariaLabel: string; disabled: boolean; working: boolean; onConfirm: () => void;
}) {
  // The dialog stays open until the user confirms, cancels or presses Escape.
  const [armed, setArmed] = useState(false);
  return (<>
    <Action aria-label={ariaLabel} disabled={disabled} working={working} onClick={() => setArmed(true)}>{label}</Action>
    <ConfirmDialog open={armed} onOpenChange={setArmed} title={ariaLabel} confirm={armedLabel} destructive disabled={disabled}
      onConfirm={() => { setArmed(false); onConfirm(); }} />
  </>
  );
}

function DiskState({ disk }: { disk: Disk }) {
  return <StatusLabel tone={disk.attached ? "idle" : disk.editing ? "warning" : "good"}>
    {disk.attached ? disk.readOnly ? t("disk.mountedReadOnly") : t("disk.mountedOnHost") : disk.editing ? t("disk.editing") : t("disk.available")}
  </StatusLabel>;
}

function Usage({ disk }: { disk: Disk }) {
  if (disk.freeBytes == null) return <span className="text-muted-foreground">{t("disk.couldnTReadTheFileSystem")}</span>;
  const used = Math.max(0, disk.size - disk.freeBytes);
  const percent = Math.min(100, (used / disk.size) * 100);
  return (
    <span className={`flex flex-col gap-2 text-xs text-muted-foreground${disk.freeBytes < disk.size * 0.1 ? " [&>span>span]:bg-warning" : ""}`}>
      <span className="block h-1.5 w-full overflow-hidden rounded-full bg-muted [&>span]:block [&>span]:h-full [&>span]:bg-chart-1" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </span>
      <span className="tabular-nums">{t("disk.usedCapacity", { used: bytes(used), total: bytes(disk.size) })}</span>
    </span>
  );
}

function CreateDisk({ disks, busy, run, onCreated }: { disks: Disk[]; busy: boolean; run: Run; onCreated: (name: string) => void }) {
  const { doing, track } = useTracked(run);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("VIM4KVM");
  const [sizeMiB, setSizeMiB] = useState(1024);
  const file = `${name.trim()}.img`;
  const invalid = !/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(name.trim()) ? t("disk.useLettersNumbersPeriodsUnderscoresAnd")
    : disks.some((disk) => disk.name.toLowerCase() === file.toLowerCase()) ? t("disk.aDataDiskWithThisName")
    : !label.trim() ? t("disk.enterAVolumeLabel")
    : sizeMiB < 64 || sizeMiB > 32768 ? t("disk.chooseACapacityBetweenMibAnd")
    : undefined;

  return (
    <>
    <Button disabled={busy || disks.length >= 8} onClick={() => setOpen(true)}><Plus />{t("disk.createDataDisk")}</Button>
    {open && <DetailsDialog open title={t("disk.createDataDisk")} onOpenChange={(value) => { if (!busy) setOpen(value); }}>
    <form
      className="flex w-full min-w-0 flex-col gap-4"
      onKeyDown={(event) => { if (event.key === "Escape" && !busy) setOpen(false); }}
      onSubmit={(event) => {
        event.preventDefault();
        if (invalid) return;
        void track("create")(t("disk.creating", { p0: String(file) }), () => request("/api/disks", { name: file, sizeMiB, label: label.trim() }), t("disk.dataDiskCreated", { p0: String(file) }))
          .then((ok) => { if (ok) { setOpen(false); setName(""); onCreated(file); } });
      }}
    >
      <label className="flex min-w-0 flex-col gap-2 text-sm">
        <span>{t("disk.name")}</span>
        <span className="flex items-center gap-2">
          <Input autoFocus value={name} disabled={busy} maxLength={60} placeholder="tools" onChange={(event) => setName(event.target.value)} />
          <span className="text-muted-foreground">.img</span>
        </span>
      </label>
      <label className="flex min-w-0 flex-col gap-2 text-sm">
        <span>{t("disk.volumeLabel")}</span>
        <Input value={label} disabled={busy} onChange={(event) => setLabel(normalizeLabel(event.target.value))} />
      </label>
      <fieldset className="flex min-w-0 flex-wrap gap-2 text-sm [&_legend]:mb-2">
        <legend>{t("disk.capacity")}</legend>
        {SIZES.map((size) => (
          <label key={size} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 has-checked:border-primary has-checked:bg-primary/5${size === sizeMiB ? " border-primary bg-primary/5" : ""}`}>
            <input className="accent-primary" type="radio" name="disk-size" checked={size === sizeMiB} disabled={busy} onChange={() => setSizeMiB(size)} />
            {bytes(size * 2 ** 20)}
          </label>
        ))}
      </fieldset>
      <p className="text-sm text-muted-foreground">{t("disk.fatWorksWithWindowsMacosAnd")}</p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {invalid && name && <span className="text-destructive">{invalid}</span>}
        <Button variant="outline" type="button" disabled={busy} onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
        <Action variant="default" type="submit" working={doing === "create"} disabled={busy || !!invalid}>{t("disk.create")}</Action>
      </div>
    </form>
    </DetailsDialog>}
    </>
  );
}

function duration(seconds: number): string {
  return seconds < 60 ? t("disk.aboutSeconds", { p0: String(Math.max(1, Math.round(seconds))) }) : t("disk.aboutMinutes", { p0: String(Math.round(seconds / 60)) });
}

function Uploads({ uploads, started, onCancel }: { uploads: Upload[]; started: number; onCancel: () => void }) {
  if (!uploads.length) return null;
  const total = uploads.reduce((sum, item) => sum + item.file.size, 0);
  const sent = uploads.reduce((sum, item) => sum + item.sent, 0);
  const index = uploads.findIndex((item) => item.state === "sending");
  const current = uploads[index];
  const finished = index < 0;
  const elapsed = (Date.now() - started) / 1000;
  const rate = elapsed > 1 ? sent / elapsed : 0;
  // After the last byte is sent the board still copies the file into the image.
  const writing = current && current.sent >= current.file.size;
  return (
    <div className={`flex flex-col gap-3 rounded-md border p-4 ${finished ? " " : ""}`} role="status">
      <div className="flex flex-wrap items-center gap-3">
        {finished ? <span className="text-success" aria-hidden="true">✓</span> : <Spinner />}
        <strong>
          {finished ? t("disk.filesUploaded", { p0: String(uploads.length) }) : writing ? t("disk.writing", { p0: String(current.file.name) }) : t("disk.uploading", { p0: String(current.file.name) })}
        </strong>
        {!finished && uploads.length > 1 && <span className="tabular-nums text-muted-foreground">{t("disk.uploadPosition", { current: index + 1, total: uploads.length })}</span>}
        <span className="tabular-nums text-muted-foreground">{bytes(sent)} / {bytes(total)}</span>
        {!finished && <Button variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>}
      </div>
      <span className="block h-1.5 w-full overflow-hidden rounded-full bg-primary/10 [&>span]:block [&>span]:h-full [&>span]:bg-primary" role="progressbar" aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={sent}>
        <span style={{ width: `${total ? (sent / total) * 100 : 100}%` }} />
      </span>
      {!finished && (
        <p className="text-sm text-muted-foreground tabular-nums">
          {rate > 0 && t("disk.sRemaining", { p0: String(bytes(rate)), p1: String(duration((total - sent) / rate)) })}
          {t("disk.filesUploadToTheBoardBefore")}</p>
      )}
    </div>
  );
}

interface Upload {
  file: File;
  sent: number;
  state: "queued" | "sending" | "done";
}

function dropBlocked(disk: Disk, busy: boolean, uploading: boolean, loaded: boolean): string | undefined {
  if (disk.attached) return t("disk.theDiskIsMountedOnThe");
  if (disk.editing) return t("disk.theDiskIsBeingEditedWait");
  if (uploading) return t("disk.waitForTheCurrentUploadBefore");
  if (busy) return t("disk.anotherOperationIsInProgressTry");
  if (!loaded) return t("disk.theFileListIsLoadingWait");
  return undefined;
}

function Files({ disk, busy, run, report, onChanged }: { disk: Disk; busy: boolean; run: Run; report: Report; onChanged: () => void }) {
  const { doing, track } = useTracked(run);
  const [path, setPath] = useState("/");
  const [listing, setListing] = useState<DiskListing>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [showHidden, setShowHidden] = useState(false);
  const [renaming, setRenaming] = useState<string>();
  const [deleting, setDeleting] = useState<DiskEntry>();
  const [newName, setNewName] = useState("");
  const [folder, setFolder] = useState<string>();
  const [pending, setPending] = useState<File[]>();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [started, setStarted] = useState(0);
  const [dragging, setDragging] = useState(false);
  const abort = useRef<AbortController>(undefined);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPath("/");
  }, [disk.name]);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    setSelected(undefined);
    setRenaming(undefined);
    setPending(undefined);
    setLoading(true);
    // The previous listing stays visible, dimmed, until the new one arrives.
    listDiskFiles(disk.name, path, controller.signal).then(setListing).catch((e) => {
      if (controller.signal.aborted) return;
      setListing(undefined);
      setError(e.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
    // Maintenance actions and host writes change the image outside this list.
  }, [disk.name, path, reload, disk.mtime, disk.freeBytes, disk.attached]);

  const uploading = uploads.some((item) => item.state !== "done");
  const readOnly = disk.attached || disk.editing || uploading;
  const locked = busy || readOnly;
  const refresh = () => { setReload((value) => value + 1); onChanged(); };
  const mutate = (key: string, label: string, action: () => Promise<unknown>, done: string) =>
    track(key)(label, action, done).then((ok) => { refresh(); return ok; });
  const entries = listing?.path === path ? listing.entries : undefined;
  const shown = listing?.path ?? path;
  // Dot entries are mostly Finder/Spotlight metadata (.fseventsd, ._name); keep them one click away.
  const hidden = listing?.entries.filter((entry) => entry.name.startsWith(".")) ?? [];
  const visible = showHidden ? listing?.entries ?? [] : listing?.entries.filter((entry) => !entry.name.startsWith(".")) ?? [];
  const crumbs = path === "/" ? [] : path.slice(1).split("/");
  const blocked = dropBlocked(disk, busy, uploading, !!entries);

  useEffect(() => {
    if (!uploading) return;
    const unload = (event: BeforeUnloadEvent) => event.preventDefault();
    const leave = (event: MouseEvent) => {
      const link = (event.target as Element).closest?.("a[href^='#/']");
      if (link && link.getAttribute("href") !== "#/disks" && !window.confirm(leaveUpload())) event.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", leave, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", leave, true);
    };
  }, [uploading]);

  const startUpload = async (files: File[], overwrite: boolean) => {
    setPending(undefined);
    const controller = new AbortController();
    abort.current = controller;
    const queue: Upload[] = files.map((file) => ({ file, sent: 0, state: "queued" }));
    setUploads(queue);
    setStarted(Date.now());
    let done = 0;
    let ok = false;
    try {
      for (const item of queue) {
        item.state = "sending";
        setUploads([...queue]);
        await uploadDiskFile(disk.name, join(path, item.file.name), item.file, overwrite, (sent) => {
          item.sent = sent;
          setUploads([...queue]);
        }, controller.signal);
        item.sent = item.file.size;
        item.state = "done";
        done += 1;
      }
      ok = true;
      report("good", t("disk.filesUploadedTo", { p0: String(done), p1: String(disk.name) }));
    } catch (e) {
      const cancelled = e instanceof DOMException && e.name === "AbortError";
      report("critical", cancelled ? t("disk.uploadCanceledFilesCompleted", { p0: String(done) }) : t("disk.filesCompleted", { p0: String((e as Error).message), p1: String(done) }));
    } finally {
      abort.current = undefined;
      refresh();
    }
    if (!ok) return setUploads([]);
    const finished = [...queue];
    setUploads(finished);
    await new Promise((resolve) => window.setTimeout(resolve, 1400));
    setUploads((current) => (current === finished ? [] : current));
  };

  const chooseFiles = (list: FileList | null) => {
    const files = [...(list ?? [])];
    if (!files.length) return;
    if (!entries) return report("critical", t("disk.waitForTheFileListTo"));
    const tooLarge = files.find((file) => file.size > FAT_FILE_LIMIT);
    if (tooLarge) return report("critical", t("disk.exceedsTheFatLimitOfLess", { p0: String(tooLarge.name) }));
    const badName = files.find((file) => !validName(file.name));
    if (badName) return report("critical", t("disk.theFilenameIsnTSupportedBy", { p0: String(badName.name) }));
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (disk.freeBytes != null && total > disk.freeBytes) {
      return report("critical", t("disk.notEnoughSpaceNeededAvailable", { p0: String(bytes(total)), p1: String(bytes(disk.freeBytes)) }));
    }
    // FAT names compare case-insensitively.
    const existing = new Set(entries.map((entry) => entry.name.toLowerCase()));
    if (files.some((file) => existing.has(file.name.toLowerCase()))) setPending(files);
    else void startUpload(files, false);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (!blocked) chooseFiles(event.dataTransfer.files);
  };

  const conflicts = pending?.filter((file) => entries?.some((entry) => entry.name.toLowerCase() === file.name.toLowerCase())) ?? [];

  return (
    <SettingsCard
      className={dragging ? "ring-2 ring-primary" : undefined}
      title={t("disk.file41")}
      description={
        <nav className="flex min-w-0 flex-wrap items-center gap-1" aria-label={t("disk.path")}>
          <Button variant="link" size="inline" className="text-sm disabled:text-foreground disabled:opacity-100" disabled={path === "/"} onClick={() => setPath("/")}>{disk.label || disk.name}</Button>
          {crumbs.map((part, index) => (
            <span key={index} className="flex items-center gap-1">
              <span className="text-muted-foreground" aria-hidden="true">/</span>
              <Button variant="link" size="inline" className="text-sm disabled:text-foreground disabled:opacity-100" disabled={index === crumbs.length - 1} onClick={() => setPath("/" + crumbs.slice(0, index + 1).join("/"))}>{part}</Button>
            </span>
          ))}
        </nav>
      }
      action={
        <span className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" disabled={locked || !entries} onClick={() => input.current?.click()}><Upload />{t("disk.uploadFiles")}</Button>
          <Button variant="outline" disabled={locked || !entries} onClick={() => { setFolder(""); }}><FolderPlus />{t("disk.createFolder")}</Button>
          <Action working={loading && !!listing} disabled={busy || !entries} onClick={() => setReload((value) => value + 1)}><RefreshCw />{t("disk.refresh")}</Action>
          <input ref={input} type="file" multiple hidden onChange={(event) => { chooseFiles(event.target.files); event.target.value = ""; }} />
        </span>
      }
      aria-label={t("disk.file41")}
      data-dragging={dragging || undefined}
      data-drop={blocked ?? t("disk.dropFilesToUploadToThis")}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = blocked ? "none" : "copy";
        setDragging(true);
      }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
      onDrop={onDrop}
    ><div className="flex min-w-0 flex-col gap-4">
      {disk.attached && (
        <p className="rounded-md border border-warning/30 bg-warning/5 p-3 text-sm text-warning-foreground" role="note">
          {t("disk.theDiskIsMountedOnThe47")}</p>
      )}
      {listing?.stale && !disk.attached && <p className="rounded-md border border-warning/30 bg-warning/5 p-3 text-sm text-warning-foreground" role="note">{t("disk.theDiskWasInUseWhen")}</p>}

      <Uploads uploads={uploads} started={started} onCancel={() => abort.current?.abort()} />

      <ConfirmDialog open={!!pending} onOpenChange={(open) => { if (!open) setPending(undefined); }} title={t("disk.replace")} confirm={t("disk.replace")} destructive
        description={t("disk.replaceFile", { name: new Intl.ListFormat(getLocale(), { style: "long", type: "conjunction" }).format(conflicts.map(file => file.name)) })}
        onConfirm={() => { if (pending) void startUpload(pending, true); }} />
      <ConfirmDialog open={!!deleting} onOpenChange={(open) => { if (!open) setDeleting(undefined); }}
        title={t("disk.delete", { p0: String(deleting?.name ?? "") })} confirm={deleting?.dir ? t("disk.deleteAllContents") : t("disk.confirmDeletion")} destructive disabled={locked}
        onConfirm={() => { if (deleting) void mutate(`rm:${deleting.name}`, t("disk.deleting", { p0: String(deleting.name) }), () => request("/api/disks/rm", { disk: disk.name, path: join(shown, deleting.name) }), t("disk.deleted", { p0: String(deleting.name) })); }} />

      {folder !== undefined && (
        <form
          className="flex w-full min-w-0 flex-wrap items-center gap-2 [&_input]:min-w-24 [&_input]:flex-1 "
          onKeyDown={(event) => { if (event.key === "Escape" && !busy) setFolder(undefined); }}
          onSubmit={(event) => {
            event.preventDefault();
            if (!validName(folder)) return;
            void mutate("mkdir", t("disk.creatingFolder"), () => request("/api/disks/mkdir", { disk: disk.name, path: join(path, folder) }), t("disk.folderCreated", { p0: String(folder) }))
              .then((ok) => { if (ok) setFolder(undefined); });
          }}
        >
          <FileIcon dir />
          <Input autoFocus aria-label={t("disk.folderName")} value={folder} disabled={busy} onChange={(event) => setFolder(event.target.value)} />
          <Button variant="outline" type="button" onClick={() => setFolder(undefined)}>{t("common.cancel")}</Button>
          <Action variant="default" type="submit" working={doing === "mkdir"} disabled={busy || !validName(folder)}>{t("disk.create60")}</Action>
        </form>
      )}

      {error ? <InlineError>{error}</InlineError>
        : !listing ? <PanelSkeleton />
        : (
          <div className={`min-w-0${loading ? " opacity-60" : ""}`} aria-busy={loading}>
            <div className="rounded-md bg-muted/60 px-2 py-3"><FileColumns size={t("disk.size")} date={t("disk.modified")} actions><span className="text-xs text-muted-foreground">{t("disk.name")}</span></FileColumns></div>
            {shown !== "/" && (
              <div className="flex min-w-0 flex-wrap items-center gap-2 border-b py-1.5" role="row">
                <Button variant="ghost" className="h-auto min-w-0 flex-1 justify-start gap-2 px-2 py-2 text-left font-normal whitespace-normal" onClick={() => setPath(parent(shown))}>
                  <FileIcon dir />
                  <span className="min-w-0 flex-1 break-all text-sm">..</span>
                </Button>
              </div>
            )}
            {visible.length === 0 && (
              <EmptyState icon={File}>{readOnly ? t("disk.thisFolderIsEmpty") : t("disk.thisFolderIsEmptyDropFiles")}</EmptyState>
            )}
            <AnimatedList className="flex flex-col divide-y" items={visible} getKey={(entry) => entry.name} label={t("disk.fileList")}>{(entry: DiskEntry) => {
              const target = join(shown, entry.name);
              const open = selected === entry.name;
              return (
                <div key={entry.name} role="row" className="group/file relative flex min-w-0 flex-wrap items-center gap-2 rounded-md px-2 py-2 hover:bg-muted/40">
                  {renaming === entry.name ? (
                    <form
                      className="flex w-full min-w-0 flex-wrap items-center gap-2 [&_input]:min-w-24 [&_input]:flex-1 "
                      onKeyDown={(event) => { if (event.key === "Escape" && !busy) setRenaming(undefined); }}
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!validName(newName) || newName === entry.name) return;
                        void mutate(`mv:${entry.name}`, t("disk.renaming"), () => request("/api/disks/mv", { disk: disk.name, from: target, to: join(shown, newName) }), t("disk.renamedTo", { p0: String(newName) }));
                      }}
                    >
                      <FileIcon dir={entry.dir} />
                      <Input autoFocus aria-label={t("disk.newName")} value={newName} disabled={busy} onChange={(event) => setNewName(event.target.value)} />
                      <Button variant="outline" type="button" onClick={() => setRenaming(undefined)}>{t("common.cancel")}</Button>
                      <Action variant="default" type="submit" working={doing === `mv:${entry.name}`} disabled={busy || !validName(newName) || newName === entry.name}>{t("disk.rename")}</Action>
                    </form>
                  ) : (
                    <>
                      <Button variant="ghost"
                        className="h-auto w-full min-w-0 justify-start px-0 py-2 text-left font-normal whitespace-normal"
                        aria-expanded={entry.dir ? undefined : open}
                        onClick={() => (entry.dir ? setPath(target) : setSelected(open ? undefined : entry.name))}
                      >
                        <FileColumns size={entry.dir ? "" : bytes(entry.size)} date={entry.mtime ? when(entry.mtime) : ""} actions={!entry.dir || !readOnly}>
                          <FileIcon dir={entry.dir} /><span className="min-w-0 text-sm">{entry.name}</span>
                        </FileColumns>
                      </Button>
                      <FileActions name={entry.name} expanded={open} actions={[
                        ...(!entry.dir ? [{ label: t("disk.download"), name: t("disk.download71", { p0: String(entry.name) }), href: diskFileURL(disk.name, target), download: entry.name }] : []),
                        ...(!readOnly ? [
                          { label: t("disk.rename"), name: t("disk.rename72", { p0: String(entry.name) }), disabled: locked, onSelect: () => { setRenaming(entry.name); setNewName(entry.name); } },
                          { label: t("disk.delete73"), name: t("disk.delete", { p0: String(entry.name) }), disabled: locked, destructive: true, working: doing === `rm:${entry.name}`, onSelect: () => setDeleting(entry) },
                        ] : []),
                      ]} />
                      {open && !entry.dir && (
                        <p className="col-span-full flex flex-wrap gap-x-4 gap-y-1 px-3 pb-3 text-xs text-muted-foreground  tabular-nums">
                          <span>{bytes(entry.size)}{entry.size >= 1024 ? t("disk.bytes", { p0: String(new Intl.NumberFormat(getLocale()).format(entry.size)) }) : ""}</span>
                          {entry.mtime ? <span>{t("disk.modifiedAt", { date: when(entry.mtime) })}</span> : null}
                          <span className="w-full break-all font-mono">{target}</span>
                        </p>
                      )}
                    </>
                  )}
                </div>
              );
            }}</AnimatedList>
            {hidden.length > 0 && (
              <p className="flex flex-wrap items-baseline gap-x-2 px-2 pt-3 text-xs text-muted-foreground">
                {showHidden ? t("disk.hiddenEntriesShownNamesBeginningWith", { p0: String(hidden.length) }) : t("disk.systemFilesHiddenNamesBeginningWith", { p0: String(hidden.length) })}
                <Button variant="link" size="inline" className="text-xs" onClick={() => setShowHidden(!showHidden)}>{showHidden ? t("disk.hide") : t("disk.show")}</Button>
              </p>
            )}
          </div>
        )}
    </div></SettingsCard>
  );
}

function Confirmed({ name, onConfirm, onCancel, children, action, busy, working }: {
  name: string; onConfirm: () => void; onCancel: () => void; children: ReactNode; action: string; busy: boolean; working: boolean;
}) {
  const [typed, setTyped] = useState("");
  return (
    <ConfirmDialog open onOpenChange={(open) => { if (!open) onCancel(); }} title={action} confirm={action}
      destructive busy={busy || working} disabled={typed !== name} closeOnConfirm={false} onConfirm={onConfirm}>
      {children}
      <label className="flex min-w-0 flex-col gap-2 text-sm">
        <span>{t("disk.confirmName", { name })}</span>
        <Input autoFocus value={typed} disabled={busy} autoComplete="off" onChange={(event) => setTyped(event.target.value)} />
      </label>
    </ConfirmDialog>
  );
}

type Danger = "resize" | "format" | "delete";

function growSizes(disk: Disk) {
  return GROW_SIZES.filter((size) => size * 2 ** 20 > disk.size);
}

function defaultGrow(disk: Disk) {
  const sizes = growSizes(disk);
  return sizes.find((size) => size * 2 ** 20 >= disk.size * 2) ?? sizes.at(-1) ?? 0;
}

function Maintenance({ disk, busy, run, onChanged, onDeleted, expanded }: {
  disk: Disk; busy: boolean; run: Run; onChanged: () => void; onDeleted: () => void; expanded: boolean;
}) {
  const { doing, track } = useTracked(run);
  const [label, setLabel] = useState(disk.label ?? "");
  const [open, setOpen] = useState<Danger | { restore: string }>();
  const [sizeMiB, setSizeMiB] = useState(defaultGrow(disk));
  const [snapshotFirst, setSnapshotFirst] = useState(true);
  const [keepSnapshots, setKeepSnapshots] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; output: string }>();
  useEffect(() => {
    setLabel(disk.label ?? "");
    setOpen(undefined);
    setCheck(undefined);
    setSizeMiB(defaultGrow(disk));
  }, [disk.name, disk.label, disk.size]);
  const locked = busy || disk.attached || disk.editing;
  const act = (key: string, text: string, action: () => Promise<unknown>, done: string) =>
    track(key)(text, action, done).then((ok) => { onChanged(); if (ok) setOpen(undefined); return ok; });
  const toggle = (danger: Danger) => setOpen(open === danger ? undefined : danger);
  const sizes = growSizes(disk);
  const formatLabel = label.trim() || "VIM4KVM";

  const dangers: { id: Danger; title: string; text: string; button: string; danger: boolean; disabled: boolean }[] = [
    { id: "resize", title: t("disk.expand"), text: t("disk.preservesFilesAndTheVolumeLabel"), button: t("disk.expand84"), danger: false,
      disabled: locked || !sizes.length || disk.snapshots.length >= 3 },
    { id: "format", title: t("disk.format"), text: t("disk.deletesAllFilesAndKeepsThe"), button: t("disk.format87"), danger: true, disabled: locked },
    { id: "delete", title: t("disk.deleteDataDisk"), text: t("disk.deletesTheImageFileAndFrees", { p0: String(bytes(disk.size)) }), button: t("disk.deleteDataDisk90"), danger: true, disabled: locked },
  ];

  return (
    <SettingsCard
      id="disk-maintenance"
      className="scroll-mt-20"
      title={t("disk.backupsAndSnapshots")}
      description={t("disk.snapshots", { p0: String(disk.snapshots.length), p1: String(expanded ? t("disk.maintenanceOptionsExpanded") : "") })}
      onKeyDown={(event) => { if (event.key === "Escape" && open && !busy) setOpen(undefined); }}
    >
      {expanded && <div className="space-y-5"><p className="text-sm text-muted-foreground">{disk.attached ? t("disk.safelyEjectTheDiskOnThe") : t("disk.unmountTheDiskFromTheHost")}</p><form
        className="grid grid-cols-1 items-center gap-x-6 gap-y-1 @md:grid-cols-[minmax(0,1fr)_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          void act("label", t("disk.changingVolumeLabel"), () => request("/api/disks/label", { name: disk.name, label: label.trim() }), t("disk.volumeLabelChangedTo", { p0: String(label.trim()) }));
        }}
      >
        <h3 className="col-start-1 row-start-1 text-sm font-medium">{t("disk.volumeLabel")}</h3>
        <span className="col-start-1 row-start-3 flex min-w-0 items-center justify-end gap-2 @max-md:mt-2 @md:col-start-2 @md:row-span-2 @md:row-start-1">
          <Input aria-label={t("disk.volumeLabel")} className="w-full font-mono @md:w-40" value={label} disabled={locked} onChange={(event) => setLabel(normalizeLabel(event.target.value))} />
          <Action type="submit" working={doing === "label"} disabled={locked || !label.trim() || label.trim() === disk.label}>{t("common.save")}</Action>
        </span>
        <p className="col-start-1 row-start-2 text-sm text-pretty text-muted-foreground">{t("disk.theNameShownOnTheHost")}</p>
      </form>

      <div className="flex flex-col gap-3">
        <SettingRow title={t("disk.checkFileSystem")} description={t("disk.checksWithoutMakingRepairsRecommendedAfter")} control={
          <Action
            working={doing === "check"}
            disabled={locked}
            onClick={() => void track("check")(t("disk.checkingFileSystem"), async () => {
              const result = await request<{ ok: boolean; output: string }>("/api/disks/check", { name: disk.name });
              setCheck(result);
              if (!result.ok) throw new Error(t("disk.theFileSystemHasErrorsRepair"));
            }, t("disk.fileSystemCheckPassed"))}
          >
            {doing === "check" ? t("disk.checking") : t("disk.startCheck")}
          </Action>} />
        {check && <pre className={`max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs${check.ok ? "" : " text-destructive"}`}>{check.output || (check.ok ? t("disk.noErrors") : "")}</pre>}
      </div></div>}

      <SettingRow title={t("disk.backUp")} description={t("disk.downloadTheFullImageToMount")} control={
        <Button asChild variant="outline"><a
          className={disk.attached && !disk.readOnly ? "pointer-events-none opacity-50" : undefined}
          aria-disabled={disk.attached && !disk.readOnly}
          href={diskImageURL(disk.name)}
          download={disk.name}
        >
          {t("disk.downloadImageSize", { size: bytes(disk.size) })}
        </a></Button>} />

      <div className="flex flex-col gap-3">
        <SettingRow title={t("disk.snapshots111")} description={t("disk.storedOnTheBoardUpTo")} control={
          <Action
            working={doing === "snapshot"}
            disabled={locked || disk.snapshots.length >= 3}
            onClick={() => void act("snapshot", t("disk.creatingSnapshot"), () => request("/api/disks/snapshot", { disk: disk.name }), t("disk.snapshotCreated"))}
          >
            {t("disk.createSnapshot")}</Action>} />
        {disk.snapshots.length === 0 ? <p className="text-sm text-muted-foreground">{t("disk.noSnapshotsYetYouCanCreate")}</p> : (
          <AnimatedList className="flex flex-col divide-y rounded-md border px-3" label={t("disk.snapshots111")} items={disk.snapshots} getKey={(snapshot) => snapshot.id}>{(snapshot) => {
              const restoring = typeof open === "object" && open.restore === snapshot.id;
              return (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
                  <span className="tabular-nums">{when(snapshot.time)}</span>
                  <span className="text-muted-foreground tabular-nums">{bytes(snapshot.size)}</span>
                  <span className="ml-auto flex items-center gap-2">
                    <Button variant="outline"
                      className={restoring ? "bg-accent" : undefined}
                      aria-label={t("disk.restoreSnapshotOf", { p0: String(when(snapshot.time)) })}
                      aria-expanded={restoring}
                      disabled={locked}
                      onClick={() => setOpen(restoring ? undefined : { restore: snapshot.id })}
                    >
                      {t("disk.restore")}</Button>
                    <ArmedButton
                      label={t("disk.delete73")}
                      armedLabel={t("disk.deleteSnapshot")}
                      ariaLabel={t("disk.deleteSnapshotOf", { p0: String(when(snapshot.time)) })}
                      disabled={busy}
                      working={doing === `snapshot-delete:${snapshot.id}`}
                      onConfirm={() => void act(`snapshot-delete:${snapshot.id}`, t("disk.deletingSnapshot"), () => request("/api/disks/snapshot/delete", { disk: disk.name, id: snapshot.id }), t("disk.snapshotDeleted"))}
                    />
                  </span>
                  {restoring && (
                    <Confirmed onCancel={() => setOpen(undefined)} name={disk.name} busy={locked} working={doing === "restore"} action={t("disk.restoreSnapshot")} onConfirm={() =>
                      void act("restore", t("disk.restoringSnapshot"), () => request("/api/disks/restore", { disk: disk.name, id: snapshot.id, confirm: disk.name }), t("disk.restoredSnapshotOf", { p0: String(when(snapshot.time)) }))}>
                      <p>{t("disk.restoreWarning", { date: when(snapshot.time), size: bytes(snapshot.size) })}</p>
                    </Confirmed>
                  )}
                </div>
              );
            }}</AnimatedList>
        )}
      </div>

      {expanded && dangers.map((item) => (
          <div key={item.id} className="flex flex-col gap-4">
            <SettingRow title={item.title} description={item.text} control={
            <Button variant={item.danger ? "destructive" : "outline"}
              className={open === item.id ? "bg-accent" : undefined}
              aria-expanded={open === item.id}
              disabled={item.disabled}
              onClick={() => toggle(item.id)}
            >
              {item.button}
            </Button>} />
            {open === "resize" && item.id === "resize" && (
              <form
                className="flex w-full flex-col gap-4 rounded-md border bg-muted/40 p-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  // The server still requires the name; resize is non-destructive and snapshots first.
                  void act("resize", t("disk.expandingDataDisk"), () => request("/api/disks/resize", { name: disk.name, sizeMiB, confirm: disk.name }), t("disk.expanded", { p0: String(disk.name) }));
                }}
              >
                <fieldset className="flex min-w-0 flex-wrap gap-2 text-sm [&_legend]:mb-2">
                  <legend>{t("disk.currentCapacity", { size: bytes(disk.size) })}</legend>
                  {sizes.map((size) => (
                    <label key={size} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 has-checked:border-primary has-checked:bg-primary/5${size === sizeMiB ? " border-primary bg-primary/5" : ""}`}>
                      <input className="accent-primary" type="radio" name="disk-grow" autoFocus={size === sizeMiB} checked={size === sizeMiB} disabled={locked} onChange={() => setSizeMiB(size)} />
                      {bytes(size * 2 ** 20)}
                    </label>
                  ))}
                </fieldset>
                <p className="text-sm text-muted-foreground">{t("disk.theBoardNeedsRoomForThe")}</p>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button variant="outline" type="button" disabled={busy} onClick={() => setOpen(undefined)}>{t("common.cancel")}</Button>
                  <Action variant="default" type="submit" working={doing === "resize"} disabled={locked || !sizeMiB}>{t("disk.expandCapacity", { size: bytes(sizeMiB * 2 ** 20) })}</Action>
                </div>
              </form>
            )}
            {open === "format" && item.id === "format" && (
              <Confirmed onCancel={() => setOpen(undefined)} name={disk.name} busy={locked} working={doing === "format"} action={t("disk.format")} onConfirm={() =>
                void act("format", t("disk.formatting"), () => request("/api/disks/format", { name: disk.name, label: formatLabel, confirm: disk.name, snapshot: snapshotFirst }), t("disk.formatted", { p0: String(disk.name) }))}>
                <p>{t("disk.formatWarning", { name: disk.name, label: formatLabel })}</p>
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox className="mt-0.5" checked={snapshotFirst} disabled={locked} onCheckedChange={(value) => setSnapshotFirst(value === true)} />
                  {t("disk.createSnapshotBeforeFormatting")} {disk.snapshots.length >= 3 ? t("disk.threeSnapshotLimitReached") : ""}
                </label>
              </Confirmed>
            )}
            {open === "delete" && item.id === "delete" && (
              <Confirmed onCancel={() => setOpen(undefined)} name={disk.name} busy={locked} working={doing === "delete"} action={t("disk.deleteDataDisk")} onConfirm={() =>
                void act("delete", t("disk.deletingDataDisk"), () => request("/api/disks/delete", { name: disk.name, confirm: disk.name, keepSnapshots }), t("disk.deleted141", { p0: String(disk.name) })).then((ok) => { if (ok) onDeleted(); })}>
                <p>{t("disk.deleteWarning", { name: disk.name, size: bytes(disk.size) })}</p>
                {disk.snapshots.length > 0 && (
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox className="mt-0.5" checked={keepSnapshots} disabled={locked} onCheckedChange={(value) => setKeepSnapshots(value === true)} />
                    {t("disk.keepSnapshots", { count: disk.snapshots.length })}</label>
                )}
              </Confirmed>
            )}
          </div>
        ))}
    </SettingsCard>
  );
}

export function DiskPanel() {
  const locale = useLocale();
  const busy = useActionStore((s) => !!s.busy);
  const run = useActionStore((s) => s.run);
  const status = useStatusStore((s) => s.status);
  const stale = useStatusStore((s) => s.stale);
  const mediaToken = stale ? undefined : `${status?.media?.token ?? ""}:${status?.media?.readOnly}`;
  const [disks, setDisks] = useState<Disk[]>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [reload, setReload] = useState(0);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getDisks(controller.signal).then((list) => {
      // A changed LUN token cancels the previous read, including JSON parsing.
      if (controller.signal.aborted) return;
      setDisks(list);
      setError(undefined);
      setSelected((name) => (list.some((disk) => disk.name === name) ? name : list[0]?.name));
    }).catch((e) => {
      if (!controller.signal.aborted) {
        setDisks(undefined);
        setError(e.message);
      }
    });
    return () => controller.abort();
    // The shared LUN token changes on mount/eject, which changes `attached`.
  }, [reload, mediaToken, locale]);
  const refresh = () => setReload((value) => value + 1);
  const disk = disks?.find((item) => item.name === selected);

  // A file dropped outside the file list would otherwise navigate away and abort uploads.
  useEffect(() => {
    const guard = (event: globalThis.DragEvent) => {
      // The file list prevents default itself when it accepts the drag.
      if (!event.defaultPrevented && event.dataTransfer?.types.includes("Files")) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "none";
      }
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, []);

  return (
    <>
      <PageHeading page="disks" action={disks && <CreateDisk disks={disks} busy={busy} run={run} onCreated={(name) => { setSelected(name); refresh(); }} />} />
      {status && <SettingsCard label={t("disk.systemDiskSpace")}><div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-3"><HardDrive className="size-7 text-muted-foreground" aria-hidden="true" /><strong className="text-sm">{t("disk.systemAvailable", { size: bytes(status.system.disk.freeBytes) })}</strong></div>
        <div className="h-2 min-w-24 flex-1 basis-40 overflow-hidden rounded-full bg-muted" aria-hidden="true"><div className="h-full rounded-full bg-chart-1" style={{ width: `${Math.max(0, Math.min(100, (1 - status.system.disk.freeBytes / Math.max(1, status.system.disk.totalBytes)) * 100))}%` }} /></div>
        <span className="text-xs tabular-nums text-muted-foreground">{t("disk.systemUsage", { used: bytes(status.system.disk.totalBytes - status.system.disk.freeBytes), total: bytes(status.system.disk.totalBytes) })}</span>
      </div></SettingsCard>}
      <div className="grid items-start gap-5 xl:grid-cols-[250px_minmax(0,1fr)]">
      <SettingsCard label={t("disk.dataDiskList")} title={t("nav.disks")}
        >
        {error ? <div className="flex flex-col items-start gap-3"><InlineError>{error}</InlineError><Button variant="outline" onClick={refresh}>{t("disk.refreshDataDisks")}</Button></div>
          : !disks ? <PanelSkeleton />
          : disks.length === 0 ? (
            <EmptyState icon={HardDrive}>{t("disk.noDataDisksYetCreateOne")}</EmptyState>
          ) : (
            <FadeIn><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1" role="radiogroup" aria-label={t("disk.selectDataDisk")}>
              {disks.map((item) => (
                <label key={item.name} className={`flex min-w-0 cursor-pointer flex-col gap-3 rounded-lg border p-4 transition-colors hover:bg-accent/60 has-checked:border-foreground/15 has-checked:bg-muted/50 has-focus-visible:ring-3 has-focus-visible:ring-ring/50${item.name === selected ? " border-foreground/15 bg-muted/50" : ""}`}>
                  <input className="sr-only" type="radio" name="disk" checked={item.name === selected} onChange={() => { setSelected(item.name); setMaintenanceOpen(false); }} />
                  <span className="flex flex-wrap items-center gap-2 [&>strong]:break-all">
                    <DiskIcon />
                    <strong className="font-medium">{item.name}</strong>
                    {item.label && <Badge variant="outline" className="font-mono text-muted-foreground">{item.label}</Badge>}
                  </span>
                  <Usage disk={item} />
                  <DiskState disk={item} />
                </label>
              ))}
            </div></FadeIn>
          )}
      </SettingsCard>
      {disk && (
        <div key={disk.name} className="flex min-w-0 flex-col gap-5">
          <SettingsCard label={t("disk.selectedDataDisk")}>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="min-w-32 flex-1 text-lg font-medium [overflow-wrap:anywhere]">{disk.name}</h2>
              <DiskState disk={disk} />
              <div className="ml-auto flex flex-wrap gap-2">
                <Button variant="outline" asChild><a href="#/media"><ExternalLink />{t("disk.mountDisk")}</a></Button>
                <Button variant="outline" aria-expanded={maintenanceOpen} aria-controls="disk-maintenance" onClick={() => {
                  setMaintenanceOpen((value) => !value);
                  if (!maintenanceOpen) requestAnimationFrame(() => document.getElementById("disk-maintenance")?.scrollIntoView({ block: "start" }));
                }}><MoreHorizontal />{t("disk.maintenance")}</Button>
              </div>
            </div>
          </SettingsCard>
          <Files disk={disk} busy={busy} run={run} report={report} onChanged={refresh} />
          <Maintenance disk={disk} expanded={maintenanceOpen} busy={busy} run={run} onChanged={refresh} onDeleted={() => { setSelected(undefined); refresh(); }} />
        </div>
      )}
      </div>
    </>
  );
}

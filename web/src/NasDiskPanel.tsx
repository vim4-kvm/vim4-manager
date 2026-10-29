import { t } from "@/i18n";
import { dateTime, number } from "@/i18n/format";
import { Badge } from "@/components/ui/badge";
import { AnimatedList } from "@/components/AnimatedList";
import { FileColumns } from "@/components/FileColumns";
import { Segmented, SegmentedOption } from "@/components/Segmented";
import { Spinner } from "@/components/Spinner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Folder } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { InlineError } from "@/components/InlineError";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingsCard } from "@/components/SettingsCard";
import { StatusDot, type Tone } from "@/components/StatusDot";
import { useStatusStore } from "@/stores/status";
import { useEffect, useState } from "react";
import { nasDiskWrite, request, storageWrite, type NasDiskCounts, type NasDiskLast, type NasDiskSession, type NasDiskState, type Storage } from "./api";
import { bytes } from "./DiskPanel";
import { hostEject, mediaName } from "./MediaPanel";
import { useLocale } from "@/i18n";

type Setup = { storage: string; path: string; mode: "ro" | "rw"; label: string; labelEdited: boolean };
type Confirm = { kind: "discard"; id: string; name: string } | { kind: "cancel" } | { kind: "trash"; id: string; files: number; bytes: number };

const SKIP_REASONS: Record<string, string> = {
  get "file size outside FAT32 range"() { return t("nasDisk.gibOrLarger"); },
  get "invalid FAT name or more than 255 UTF-16 units"() { return t("nasDisk.filenameUnsupportedByTheUsbDrive"); },
  get "case-insensitive duplicate"() { return t("nasDisk.duplicateNameInTheSameFolder"); },
  get "symbolic link or special file"() { return t("nasDisk.symbolicLinkOrSpecialFile"); },
  get "path depth limit"() { return t("nasDisk.folderNestingLimitExceeded"); },
  get "directory entry limit"() { return t("nasDisk.tooManyEntriesInTheFolder"); },
  get "excluded directory"() { return t("nasDisk.managementDirectory"); },
};

const CONFIRM_TITLE = { get discard() { return t("nasDisk.discardChanges"); }, get cancel() { return t("nasDisk.cancelMount"); }, get trash() { return t("nasDisk.emptyRecoveryFolder"); } };
const HIDDEN_RESULT_KEY = "nasdisk-hidden-last";

export function folderLabel(path: string) {
  const name = path.split("/").filter(Boolean).pop() ?? "";
  // Use the generic label rather than a misleading partial transliteration.
  if (/[^\x20-\x7e]/.test(name)) return "NAS";
  const label = name.toUpperCase().replace(/[^A-Z0-9 _-]/g, "").trim().slice(0, 11).trim();
  return label || "NAS";
}

function displayPath(path: string) {
  return path === "/" ? t("nasDisk.rootFolder") : path.replace(/^\//, "");
}

function counts(c: NasDiskCounts) {
  return [
    c.writes && t("nasDisk.filesWritten", { p0: String(c.writes) }),
    c.mkdirs && t("nasDisk.foldersCreated", { p0: String(c.mkdirs) }),
    c.renames && t("nasDisk.itemsRenamedOrMoved", { p0: String(c.renames) }),
    c.deletes && t("nasDisk.itemsDeletedMovedToRecoveryFolder", { p0: String(c.deletes) }),
    c.conflicts && t("nasDisk.conflictCopies", { p0: String(c.conflicts) }),
  ]
    .filter(Boolean)
    .join(" · ");
}

function when(seconds: number) {
  return dateTime(seconds * 1000, { second: undefined });
}

export function useNasDisk() {
  const locale = useLocale();
  const [state, setState] = useState<NasDiskState>();
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [hiddenResult, setHiddenResult] = useState(() => {
    try {
      return localStorage.getItem(HIDDEN_RESULT_KEY);
    } catch {
      return null;
    }
  });
  const active = !!state?.session;
  const last = state?.last && state.last.id !== hiddenResult ? state.last : undefined;
  const hasActivity = active || !!last || !!state?.pending.length;

  useEffect(() => {
    if (pending) return;
    let cancelled = false;
    let timer: number;
    async function refresh() {
      try {
        const next = await request<NasDiskState>("/api/nasdisk", undefined, AbortSignal.timeout(12000));
        if (!cancelled) setState(next);
      } catch {
        if (!cancelled) setState((s) => (s ? { ...s, known: false } : s));
      } finally {
        if (!cancelled) timer = window.setTimeout(refresh, active ? 1500 : 4000);
      }
    }
    void refresh();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pending, active, locale]);

  async function act(label: string, run: () => Promise<unknown>) {
    setPending(label);
    setError("");
    try {
      await run();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setPending("");
    }
  }

  function hideLast() {
    if (!last) return;
    setHiddenResult(last.id);
    try {
      localStorage.setItem(HIDDEN_RESULT_KEY, last.id);
    } catch {
      // Storage may be unavailable; hiding still works for this visit.
    }
  }

  return { state, last, hasActivity, pending, error, act, hideLast };
}

export function NasDiskPanel({ disk, locked: parentLocked }: { disk: ReturnType<typeof useNasDisk>; locked: boolean }) {
  const { state, last, pending, error } = disk;
  const [confirming, setConfirming] = useState<Confirm>();
  const [showSkipped, setShowSkipped] = useState(false);
  const active = !!state?.session;
  const locked = parentLocked || !!pending || !state?.known;
  const session = state?.session;
  function act(label: string, run: () => Promise<unknown>) {
    setConfirming(undefined);
    return disk.act(label, run);
  }

  if (!disk.hasActivity) return null;

  return (
    <SettingsCard label={t("nasDisk.usbDriveActivity")}><div role="group" aria-label={t("nasDisk.usbDrive")} className="flex min-w-0 flex-col gap-4">
      {pending && (
        <span className="text-muted-foreground" role="status">
          <Spinner />
          {pending}
        </span>
      )}
      {state && !state.known && <p className="text-sm text-warning-foreground">{t("nasDisk.couldnTReadTheUsbDrive")}</p>}

      {session ? (
        <SessionCard
          key={session.id}
          session={session}
          locked={locked}
          showSkipped={showSkipped}
          setShowSkipped={setShowSkipped}
          onCancel={() => setConfirming({ kind: "cancel" })}
          onReattach={() => void act(t("nasDisk.remounting"), () => nasDiskWrite("/reattach", { id: session.id }))}
          onForce={() => void act(t("nasDisk.writingBack"), () => nasDiskWrite("/commit", { id: session.id, force: true }))}
          onRetry={() => void act(t("nasDisk.writingBack"), () => nasDiskWrite("/commit", { id: session.id }))}
          onDiscard={() =>
            session.mode === "ro"
              ? void act(t("nasDisk.finishing"), () => nasDiskWrite("/discard", { id: session.id, confirm: session.id }))
              : setConfirming({ kind: "discard", id: session.id, name: `${session.storageName} › ${displayPath(session.path)}` })
          }
        />
      ) : (
        last && (
          <LastResult
            key={last.id}
            last={last}
            locked={locked}
            onEmptyTrash={(t) => setConfirming({ kind: "trash", id: last.id, files: t.files, bytes: t.bytes })}
            onHide={() => {
              disk.hideLast();
              setConfirming(undefined);
            }}
          />
        )
      )}

      {!!state?.pending.length && (
        <div className="flex flex-col gap-3 rounded-md border border-warning/30 p-4 [&_h4]:font-medium [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-4 [&_li]:flex [&_li]:flex-wrap [&_li]:items-center [&_li]:gap-2 [&_li>div]:flex [&_li>div]:min-w-0 [&_li>div]:flex-1 [&_li>div]:flex-col [&_li>div]:gap-1">
          <h4>{t("nasDisk.changesNotWrittenBack")}</h4>
          <p className="text-muted-foreground">{t("nasDisk.theseUsbDriveChangesWerenT")}</p>
          <ul>
            {state.pending.map((p) => (
              <li key={p.id}>
                <div>
                  <strong>
                    {p.storageName} › {displayPath(p.path)}
                  </strong>
                  <span className="text-muted-foreground">
                    {t("nasDisk.pendingSummary", { date: when(p.startedAt), size: bytes(p.writtenBytes) })}
                    {p.journal && t("nasDisk.writebackInterrupted")}
                  </span>
                </div>
                <Button variant="outline" disabled={locked || active} onClick={() => void act(t("nasDisk.writingBack"), () => nasDiskWrite("/commit", { id: p.id }))}>
                  {t("nasDisk.writeBackToNas")}</Button>
                <Button variant="outline"
                  disabled={locked || active}
                  onClick={() => setConfirming({ kind: "discard", id: p.id, name: `${p.storageName} › ${displayPath(p.path)}` })}
                >
                  {t("nasDisk.discard")}</Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {confirming && (
        <ConfirmDialog open onOpenChange={(open) => { if (!open) setConfirming(undefined); }}
          title={CONFIRM_TITLE[confirming.kind]} confirm={CONFIRM_TITLE[confirming.kind]} cancel={t("nasDisk.back")} destructive disabled={locked}
          description={confirming.kind === "discard"
            ? t("nasDisk.discardAllHostChangesInNas", { p0: String(confirming.name) })
            : confirming.kind === "trash"
              ? t("nasDisk.permanentlyDeleteFilesFromTheRecovery", { p0: number(confirming.files), p1: bytes(confirming.bytes) })
              : t("nasDisk.stopPreparingTheUsbDriveIt")}
          onConfirm={() => void (confirming.kind === "discard"
            ? act(t("nasDisk.discardingChanges"), () => nasDiskWrite("/discard", { id: confirming.id, confirm: confirming.id }))
            : confirming.kind === "trash"
              ? act(t("nasDisk.emptyingRecoveryFolder"), () => nasDiskWrite("/trash-empty", { id: confirming.id, confirm: confirming.id }))
              : act(t("nasDisk.canceling"), () => nasDiskWrite("/cancel", {})))} />
      )}
      {error && <InlineError>{error}</InlineError>}
    </div></SettingsCard>
  );
}

export function NasDiskSetup({
  storage,
  locked,
  onCancel,
  onStart,
}: {
  storage: Storage;
  locked: boolean;
  onCancel: () => void;
  onStart: (setup: Setup) => void;
}) {
  const status = useStatusStore((s) => s.status);
  const [setup, setSetup] = useState<Setup>({ storage: storage.id, path: "/", mode: storage.writable === false ? "ro" : "rw", label: "NAS", labelEdited: false });
  const [editingLabel, setEditingLabel] = useState(false);
  const [retry, setRetry] = useState(0);
  const [dirs, setDirs] = useState<{ names: string[]; truncated: boolean }>();
  const [dirError, setDirError] = useState("");
  const [newName, setNewName] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [mkdirError, setMkdirError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setDirs(undefined);
    setDirError("");
    setNewName(undefined);
    setMkdirError("");
    request<{ entries: { name: string }[]; truncated: boolean }>(
      `/api/storage/dirs?${new URLSearchParams({ id: setup.storage, path: setup.path })}`,
      undefined,
      AbortSignal.timeout(10000),
    )
      .then((r) => !cancelled && setDirs({ names: r.entries.map((e) => e.name).filter((n) => n !== ".vim4-nasdisk"), truncated: r.truncated }))
      .catch((e) => !cancelled && setDirError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [setup.storage, setup.path, retry]);

  const go = (path: string) => setSetup({ ...setup, path, label: setup.labelEdited ? setup.label : folderLabel(path) });
  const parts = setup.path.split("/").filter(Boolean);
  const labelValid = /^[A-Z0-9 _-]{1,11}$/.test(setup.label) && setup.label.trim() === setup.label;
  const readOnlyOnly = storage.writable === false;
  const occupiedMedia = status?.media?.inserted && !status.media.nasdisk ? status.media : undefined;
  const canStart = !locked && !creating && labelValid && !!dirs && !occupiedMedia;
  const nameTrimmed = newName?.trim() ?? "";
  const nameProblem = !nameTrimmed
    ? ""
    : nameTrimmed === "." || nameTrimmed === ".." || nameTrimmed === ".vim4-nasdisk"
      ? t("nasDisk.thisNameCanTBeUsed")
      : /[\x00-\x1f\x7f\\/"*?<>|:%]/.test(nameTrimmed)
      ? t("nasDisk.namesCanTContainOrControl")
      : new TextEncoder().encode(nameTrimmed).length > 255
        ? t("nasDisk.nameIsTooLong")
        : dirs?.names.some((n) => n.toLowerCase() === nameTrimmed.toLowerCase())
          ? t("nasDisk.aFolderWithThisNameAlready")
          : "";

  async function mkdir() {
    if (!nameTrimmed || nameProblem || creating) return;
    setCreating(true);
    setMkdirError("");
    try {
      const r = await storageWrite<{ path: string }>("/mkdir", { id: setup.storage, path: setup.path, name: nameTrimmed });
      go(r.path);
    } catch (e) {
      setMkdirError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <form aria-label={t("nasDisk.chooseAFolderToUseAs")}
      className="flex min-w-0 flex-col gap-4 rounded-md border bg-muted/40 p-4 "
      onSubmit={(e) => {
        e.preventDefault();
        if (canStart) onStart({ ...setup, mode: readOnlyOnly ? "ro" : setup.mode });
      }}
    >
      <h4>{t("nasDisk.chooseAFolderToUseAs")}</h4>

      <div className="flex min-w-0 flex-col gap-3 rounded-md border bg-card p-3">
        <nav className="flex flex-wrap items-center gap-1" aria-label={t("nasDisk.folderPath")}>
          <Button variant="link" size="inline" type="button" aria-current={parts.length === 0 ? "location" : undefined} onClick={() => go("/")}>
            {storage?.name ?? "NAS"}
          </Button>
          {parts.map((part, i) => (
            <span key={i}>
              <span className="text-muted-foreground" aria-hidden="true">
                ›
              </span>
              <Button variant="link" size="inline"
                type="button"
                aria-current={i === parts.length - 1 ? "location" : undefined}
                onClick={() => go("/" + parts.slice(0, i + 1).join("/"))}
              >
                {part}
              </Button>
            </span>
          ))}
        </nav>
        {dirError ? (
          <div className="text-sm text-destructive p-3 text-center text-sm" role="alert">
            {dirError} <Button variant="link" size="inline" type="button" onClick={() => setRetry((n) => n + 1)}>{t("common.retry")}</Button>
          </div>
        ) : !dirs ? (
          <PanelSkeleton label={t("common.loading")} rows={2} />
        ) : dirs.names.length === 0 ? (
          <p className="text-muted-foreground p-3 text-center text-sm">{t("nasDisk.noSubfolders")}</p>
        ) : (
          <div>
          <AnimatedList className="flex max-h-64 flex-col divide-y overflow-auto" label={t("nasDisk.subfolders")} items={dirs.names} getKey={(name) => name}>{(name) => (
                <Button variant="ghost" className="h-auto w-full px-0 py-2 text-left font-normal" type="button" onClick={() => go(`${setup.path === "/" ? "" : setup.path}/${name}`)}>
                  <FileColumns>
                  <Folder aria-hidden="true" className="size-4 shrink-0" />
                  <span>{name}</span>
                  <span className="ml-auto" aria-hidden="true">›</span>
                  </FileColumns>
                </Button>
            )}</AnimatedList>
            {dirs.truncated && <p className="p-3 text-center text-sm text-muted-foreground">{t("nasDisk.showingTheFirstFoldersOnly")}</p>}
          </div>
        )}
        {dirs && !readOnlyOnly && (
          <div className="border-t pt-3">
            {newName === undefined ? (
              <Button variant="link" size="inline" type="button" disabled={locked} onClick={() => setNewName("")}>
                <span aria-hidden="true">+ </span>{t("disk.createFolder")}</Button>
            ) : (
              <>
                <div className="flex flex-wrap gap-2 [&_input]:min-w-32 [&_input]:flex-1">
                  <Input
                    aria-label={t("nasDisk.newFolderName")}
                    placeholder={t("disk.folderName")}
                    value={newName}
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={!!nameProblem}
                    onChange={(e) => {
                      setNewName(e.target.value);
                      setMkdirError("");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void mkdir();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setNewName(undefined);
                      }
                    }}
                  />
                  <Button variant="default" type="button" disabled={locked || creating || !nameTrimmed || !!nameProblem} onClick={() => void mkdir()}>
                    {creating ? t("nasDisk.creating") : t("disk.create")}
                  </Button>
                  <Button variant="outline" type="button" disabled={creating} onClick={() => setNewName(undefined)}>
                    {t("common.cancel")}</Button>
                </div>
                {(nameProblem || mkdirError) && <span className="text-xs text-muted-foreground text-destructive">{nameProblem || mkdirError}</span>}
              </>
            )}
          </div>
        )}
        <p className="border-t pt-3 text-sm [overflow-wrap:anywhere]">
          <strong>{t("storage.selectedFolder", { name: storage.name, path: displayPath(setup.path) })}</strong>
        </p>
      </div>

      <Segmented label={t("nasDisk.mode")} className="max-sm:grid-cols-1">
        <SegmentedOption title={t("nasDisk.writable")} detail={readOnlyOnly ? t("nasDisk.theNasDoesnTAllowWriting") : t("nasDisk.changesWriteBackToTheNas")} pressed={setup.mode === "rw" && !readOnlyOnly} disabled={readOnlyOnly} onClick={() => setSetup({ ...setup, mode: "rw" })} />
        <SegmentedOption title={t("nasDisk.readOnly")} detail={t("nasDisk.theHostCanOnlyReadFiles")} pressed={setup.mode === "ro" || readOnlyOnly} onClick={() => setSetup({ ...setup, mode: "ro" })} />
      </Segmented>

      {editingLabel ? (
        <label className="flex min-w-0 flex-col gap-2 text-sm max-w-64">
          {t("disk.volumeLabel")}<Input
            value={setup.label}
            autoFocus
            maxLength={11}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!labelValid}
            onChange={(e) => setSetup({ ...setup, label: e.target.value.toUpperCase(), labelEdited: true })}
          />
          {!labelValid && <span className="text-xs text-muted-foreground">{t("nasDisk.uppercaseLettersNumbersSpacesUnderscoresOr")}</span>}
        </label>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span>{t("nasDisk.savedLabel", { label: setup.label })}</span>
          <Button variant="link" size="inline" type="button" onClick={() => setEditingLabel(true)}>{t("nasDisk.edit")}</Button>
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        {t("nasDisk.filesOfGibOrLargerAnd")}</p>
      {occupiedMedia && (
        <p className="text-sm text-warning-foreground" role="status">
          {t("nasDisk.mountedMediaWarning", { name: mediaName(occupiedMedia) })} <a className="text-sm text-link underline-offset-4 hover:underline" href="#/media">{t("nasDisk.virtualMediaPage")}</a></p>
      )}
      {status && status.hardware.usb !== "configured" && (
        <p className="text-sm text-warning-foreground" role="status">{t("nasDisk.theHostIsnTConnectedOver")}</p>
      )}

      <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
        <Button variant="outline" type="button" onClick={onCancel}>
          {t("common.cancel")}</Button>
        <Button variant="default" type="submit" disabled={!canStart}>
          {t("nasDisk.mountOnHost")}</Button>
      </div>
    </form>
  );
}

function SessionCard({
  session: s,
  locked,
  showSkipped,
  setShowSkipped,
  onCancel,
  onReattach,
  onForce,
  onRetry,
  onDiscard,
}: {
  session: NasDiskSession;
  locked: boolean;
  showSkipped: boolean;
  setShowSkipped: (v: boolean) => void;
  onCancel: () => void;
  onReattach: () => void;
  onForce: () => void;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const rw = s.mode === "rw";
  const tone: Tone =
    s.state === "attached" ? (s.hostConnected ? "good" : "warning") : s.state === "needs-decision" || s.state === "failed" ? "critical" : "warning";
  const title = {
    scanning: t("nasDisk.scanningFolderEntriesScanned", { p0: number(s.scanned) }),
    attaching: t("nasDisk.connectingToHost"),
    attached: s.hostConnected ? t("disk.mountedOnHost") : t("nasDisk.mountedUsbDisconnected"),
    parsing: t("nasDisk.ejectedCheckingChanges"),
    committing: t("nasDisk.writingChangesBackToNas"),
    "needs-decision": t("nasDisk.theUsbDriveWasnTSafely"),
    failed: t("nasDisk.usbDriveProblem"),
  }[s.state];
  const progress = s.progress;
  const ratio = progress ? (progress.bytesTotal ? progress.bytesDone / progress.bytesTotal : progress.total ? progress.done / progress.total : 0) : 0;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-wrap items-start gap-3">
        <StatusDot tone={tone} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 [&_strong]:font-medium">
            <strong>
              {t("nasDisk.driveHeading", { name: s.storageName, path: displayPath(s.path) })}
            </strong>
            <Badge variant="secondary">{rw ? t("nasDisk.writable") : t("nasDisk.readOnly")}</Badge>
            <Badge variant="secondary">{s.label}</Badge>
          </div>
          <span key={s.state} className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            {(s.state === "scanning" || s.state === "attaching" || s.state === "parsing" || s.state === "committing") && (
              <Spinner />
            )}
            {title}
          </span>
          {s.state !== "scanning" && s.volumeBytes > 0 && (
            <span className="text-muted-foreground text-xs">
              {t("nasDisk.driveUsage", { files: t("nasDisk.filesCount", { count: s.files }), dirs: t("nasDisk.foldersCount", { count: s.dirs }), used: bytes(s.usedBytes), total: bytes(s.volumeBytes) })}
              {rw && s.writtenBytes > 0 && t("nasDisk.hostHasWritten", { p0: String(bytes(s.writtenBytes)) })}
            </span>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {(s.state === "scanning" || s.state === "attaching") && (
            <Button variant="outline" disabled={locked} onClick={onCancel}>
              {t("common.cancel")}</Button>
          )}
        </div>
      </div>

      {s.nasStalled && (s.state === "attached" || s.state === "committing") && (
        <p className="text-sm text-warning-foreground" role="status">
          {s.state === "attached" ? t("nasDisk.theNasIsnTRespondingHost") : t("nasDisk.theNasIsnTRespondingWriteback")}
        </p>
      )}
      {s.state === "attached" && (
        <div className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p>{rw ? t("nasDisk.safelyEjectTheDriveOnThe") : t("nasDisk.safelyEjectTheDriveOnThe237")}</p>
          <details className="text-xs [&_summary]:cursor-pointer [&_summary]:text-link [&_p]:mt-2 [&_code]:mt-2 [&_code]:block [&_li]:mt-2"><summary>{t("nasDisk.howToSafelyEject")}</summary><p>{hostEject}</p></details>
        </div>
      )}

      {s.state === "committing" && progress && (
        <div className="flex flex-col gap-2 text-xs">
          <span className="block h-1.5 w-full overflow-hidden rounded-full bg-primary/10 [&>span]:block [&>span]:h-full [&>span]:rounded-full [&>span]:bg-primary">
            <span style={{ width: `${Math.max(2, ratio * 100)}%` }} />
          </span>
          <span className="text-muted-foreground">
            {t("nasDisk.writebackProgress", { done: progress.done, total: progress.total })}{progress.bytesTotal > 0 && ` · ${bytes(progress.bytesDone)} / ${bytes(progress.bytesTotal)}`}
            {progress.current && ` · ${progress.current}`}
          </span>
        </div>
      )}
      {s.state === "committing" && s.plan && <p className="text-muted-foreground text-sm">{counts(s.plan) || t("nasDisk.noChangesToWriteBack")}</p>}

      {s.state === "needs-decision" && s.decision && (
        <div className="flex flex-col gap-4 rounded-md border border-warning/30 bg-warning/5 p-4">
          <p>
            {s.decision.reason ||
              t("nasDisk.theDriveMayHaveBeenDisconnected")}
            {t("nasDisk.changesAreStillInTheNas")}</p>
          <Detail text={s.detail} />
          <ul className="flex flex-col gap-4 [&>li]:flex [&>li]:flex-wrap [&>li]:items-center [&>li]:gap-3">
            <li>
              <Button variant="default" disabled={locked} onClick={onReattach}>
                {t("nasDisk.remount")}</Button>
              <span className="text-muted-foreground">{t("nasDisk.letTheHostCheckAndRepair")}</span>
            </li>
            {s.decision.canForce && (
              <li>
                <Button variant="outline" disabled={locked} onClick={onForce}>
                  {t("nasDisk.writeBackReadableFiles")}</Button>
                <span className="text-muted-foreground">{t("nasDisk.writeOnlyCompleteReadableFilesDon")}</span>
              </li>
            )}
            <li>
              <Button variant="destructive" disabled={locked} onClick={onDiscard}>
                {t("nasDisk.discardChanges247")}</Button>
              <span className="text-muted-foreground">{t("nasDisk.keepNasFilesAsTheyWere")}</span>
            </li>
          </ul>
        </div>
      )}

      {s.state === "failed" && (
        <div className="flex flex-col gap-4 rounded-md border border-warning/30 bg-warning/5 p-4">
          <p>
            {s.error || t("nasDisk.theUsbDriveHasAProblem")}
            {rw && t("nasDisk.changesNotWrittenBackRemainIn")}
          </p>
          <Detail text={s.detail} />
          <ul className="flex flex-col gap-4 [&>li]:flex [&>li]:flex-wrap [&>li]:items-center [&>li]:gap-3">
            {rw && (
              <li>
                <Button variant="default" disabled={locked} onClick={onRetry}>
                  {t("nasDisk.retryWriteback")}</Button>
                <span className="text-muted-foreground">{t("nasDisk.tryAgainWhenTheNasIs")}</span>
              </li>
            )}
            <li>
              <Button variant="destructive" disabled={locked} onClick={onDiscard}>
                {rw ? t("nasDisk.discardChanges247") : t("nasDisk.finish")}
              </Button>
              <span className="text-muted-foreground">{rw ? t("nasDisk.keepNasFilesAsTheyWere") : t("nasDisk.endThisUsbDriveSession")}</span>
            </li>
          </ul>
        </div>
      )}

      {s.skippedCount > 0 && (
        <div className="text-xs [&_ul]:mt-2 [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-2 [&_li]:flex [&_li]:flex-wrap [&_li]:gap-2">
          <Button variant="link" size="inline" type="button" aria-expanded={showSkipped} onClick={() => setShowSkipped(!showSkipped)}>
            {t("nasDisk.excludedCount", { count: s.skippedCount })}</Button>
          <span className="text-muted-foreground"> {t("nasDisk.theyRemainOnTheNasAnd")}</span>
          {showSkipped && (
            <ul>
              {s.skipped.map((item) => (
                <li key={item.path}>
                  <code className="font-mono break-all">{item.path}</code>
                  <span className="text-muted-foreground">{SKIP_REASONS[item.reason] ?? item.reason}</span>
                </li>
              ))}
              {s.skippedCount > s.skipped.length && <li className="text-muted-foreground">{t("nasDisk.moreExcluded", { count: s.skippedCount - s.skipped.length })}</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Detail({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <details className="text-xs [&_summary]:cursor-pointer [&_summary]:text-link [&_p]:mt-2 [&_code]:mt-2 [&_code]:block [&_li]:mt-2">
      <summary>{t("nasDisk.technicalDetails")}</summary>
      <code className="font-mono break-all">{text}</code>
    </details>
  );
}

function LastResult({ last, locked, onEmptyTrash, onHide }: { last: NasDiskLast; locked: boolean; onEmptyTrash: (t: { files: number; bytes: number }) => void; onHide: () => void }) {
  const where = `${last.storageName} › ${displayPath(last.path)}`;
  const text = {
    committed: counts(last.summary) ? t("nasDisk.writtenBackToNas", { p0: String(counts(last.summary)) }) : t("nasDisk.writtenBackToNas261"),
    unchanged: last.mode === "ro" ? t("nasDisk.readOnlyUsbDriveEjected") : t("nasDisk.ejectedTheHostDidnTChange"),
    discarded: t("nasDisk.hostChangesDiscarded"),
    cancelled: t("nasDisk.mountCanceled"),
    failed: t("nasDisk.couldnTWriteBack", { p0: String(last.error || t("nasDisk.unknownProblem")) }),
  }[last.result];
  return (
    <div role="group" aria-label={t("nasDisk.lastSession")} className={`flex flex-col gap-3${last.result === "failed" ? " text-destructive" : ""}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]"><span className="text-muted-foreground">{t("nasDisk.lastHeading", { date: when(last.finishedAt), location: where })}</span> — {text}</span>
        {!!last.trash?.files && <span className="flex flex-wrap items-center gap-2 text-xs" title={t("nasDisk.recoveryFolderFilesDeletedOrReplaced", { p0: number(last.trash.files) })}>
          <span className="text-muted-foreground">{t("nasDisk.recoverySize", { size: bytes(last.trash.bytes) })}</span>
          <Button variant="outline" type="button" disabled={locked} onClick={() => onEmptyTrash(last.trash!)}>{t("nasDisk.empty")}</Button>
        </span>}
        <Button variant="outline" type="button" aria-label={t("nasDisk.hideLastResult")} onClick={onHide}>×</Button>
      </div>
      {last.result === "failed" && <Detail text={last.detail} />}
      {last.conflicts.length > 0 && (
        <details className="text-xs [&_summary]:cursor-pointer [&_summary]:text-link [&_p]:mt-2 [&_code]:mt-2 [&_code]:block [&_li]:mt-2" open>
          <summary>{t("nasDisk.conflictCount", { count: last.conflicts.length })}</summary>
          <ul>
            {last.conflicts.map((c) => (
              <li key={c.path}>
                <code className="font-mono break-all">{c.path}</code>
                <span className="text-muted-foreground">
                  {c.copy ? (
                    <>
                      {t("nasDisk.conflictCopy", { name: c.copy })}
                    </>
                  ) : (
                    t("nasDisk.theHostDeletedThisFileBut")
                  )}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

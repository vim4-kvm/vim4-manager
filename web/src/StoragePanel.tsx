import { t } from "@/i18n";
import { NativeSelect } from "@/components/ui/native-select";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Segmented, SegmentedOption } from "@/components/Segmented";
import { Spinner } from "@/components/Spinner";
import { FadeIn } from "@/components/Motion";
import { AnimatedList } from "@/components/AnimatedList";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MoreHorizontal, Pencil, Plus, Server } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { Fact, FactGrid } from "@/components/FactGrid";
import { InlineError } from "@/components/InlineError";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingsCard } from "@/components/SettingsCard";
import { PageHeading } from "@/components/PageHeading";
import { Notice } from "@/components/Notice";
import { StatusDot, type Tone } from "@/components/StatusDot";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useActionStore } from "@/stores/action";
import { useEffect, useState } from "react";
import { nasDiskWrite, request, storageWrite, type Storage, type StorageConfig, type StorageState, type StorageTest, type StorageType } from "./api";
import { bytes } from "./DiskPanel";
import { CopyButton } from "@/components/CopyButton";
import { PasswordInput } from "@/components/PasswordInput";
import { NasDiskPanel, NasDiskSetup, useNasDisk } from "./NasDiskPanel";
import { useLocale } from "@/i18n";

const VERSIONS: Record<StorageType, { value: string; label: string }[]> = {
  smb: [
    { value: "auto", get label() { return t("storage.automatic"); } },
    { value: "3.1.1", label: "SMB 3.1.1" },
    { value: "3.0", label: "SMB 3.0" },
    { value: "2.1", label: "SMB 2.1" },
    { value: "2.0", label: "SMB 2.0" },
    { value: "1.0", get label() { return t("storage.smbInsecure"); } },
  ],
  nfs: [
    { value: "auto", get label() { return t("storage.automatic"); } },
    { value: "4.2", label: "NFS 4.2" },
    { value: "4.1", label: "NFS 4.1" },
    { value: "4.0", label: "NFS 4.0" },
    { value: "3", label: "NFS 3" },
  ],
};

const EMPTY: StorageConfig = {
  name: "",
  type: "smb",
  server: "",
  share: "",
  domain: "",
  username: "",
  version: "auto",
  autoMount: true,
};

type Editor = { draft: StorageConfig; password: string; editing: boolean; advanced: boolean };
type Confirm = { kind: "unmount" | "delete"; storage: Storage };

export function storageAddress(s: Pick<StorageConfig, "type" | "server" | "share">) {
  const host = s.server.includes(":") && !s.server.startsWith("[") ? `[${s.server}]` : s.server;
  return s.type === "smb" ? `//${host}/${s.share.replace(/^\/+/, "")}` : `${host}:${s.share}`;
}

function defaultName(d: StorageConfig) {
  const tail = d.share.split("/").filter(Boolean).pop();
  return tail || d.server;
}

function draftError(d: StorageConfig) {
  if (!d.server.trim()) return t("storage.enterAServerAddress");
  if (!d.share.trim()) return d.type === "smb" ? t("storage.enterAShareName") : t("storage.enterAnExportPath");
  if (d.type === "nfs" && !d.share.startsWith("/")) return t("storage.theExportPathMustStartWith");
  return "";
}

function capacity(s: Storage) {
  if (!s.mounted) return undefined;
  if (s.totalBytes == null || s.freeBytes == null) return { text: s.stale ? t("storage.nasNotResponding") : t("storage.capacityUnknown"), ratio: undefined };
  const used = 1 - s.freeBytes / Math.max(1, s.totalBytes);
  return { text: t("storage.available", { p0: bytes(Math.max(0, s.totalBytes - s.freeBytes)), p1: bytes(s.totalBytes) }), ratio: used };
}

function stateLabel(s: Storage): { tone: Tone; text: string } {
  if (s.state === "mounting") return { tone: "warning", text: t("storage.connecting") };
  if (s.mounted && s.stale) return { tone: "warning", text: t("storage.connectedNotResponding") };
  if (s.mounted) return { tone: "good", text: s.writable === false ? t("storage.connectedReadOnly") : t("storage.connected") };
  if (s.state === "error") return { tone: "critical", text: t("storage.couldnTConnect") };
  return { tone: "idle", text: t("storage.disconnected") };
}

export function StoragePanel() {
  const locale = useLocale();
  const busy = useActionStore((s) => !!s.busy);
  const [state, setState] = useState<StorageState>();
  const [stale, setStale] = useState(true);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<Editor>();
  const [test, setTest] = useState<StorageTest & { running?: boolean }>();
  const [confirming, setConfirming] = useState<Confirm>();
  const [diskSetup, setDiskSetup] = useState<string>();
  const [selectedID, setSelectedID] = useState<string>();
  const [connectionTest, setConnectionTest] = useState<{ id: string; result: StorageTest }>();
  const disk = useNasDisk();
  const session = disk.state?.session;

  useEffect(() => {
    if (session) setDiskSetup(undefined);
  }, [session]);

  useEffect(() => {
    if (pending) return;
    let cancelled = false;
    let timer: number;
    async function refresh() {
      try {
        const next = await request<StorageState>("/api/storage", undefined, AbortSignal.timeout(12000));
        if (!cancelled) {
          setState(next);
          setStale(!next.known);
        }
      } catch {
        if (!cancelled) setStale(true);
      } finally {
        if (!cancelled) timer = window.setTimeout(refresh, 3000);
      }
    }
    void refresh();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pending, locale]);

  async function act(label: string, run: () => Promise<unknown>) {
    setPending(label);
    setError("");
    setConfirming(undefined);
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

  function openEditor(storage?: Storage) {
    setDiskSetup(undefined);
    setConnectionTest(undefined);
    setTest(undefined);
    setError("");
    setEditor(
      storage
        ? { draft: { ...storage }, password: "", editing: true, advanced: storage.version !== "auto" || !!storage.domain }
        : { draft: { ...EMPTY, type: state?.tools.smb === false && state.tools.nfs ? "nfs" : "smb" }, password: "", editing: false, advanced: false },
    );
  }

  function payload(e: Editor) {
    const d = e.draft;
    return {
      ...d,
      name: d.name.trim() || defaultName(d),
      server: d.server.trim(),
      share: d.share.trim(),
      username: d.type === "smb" ? d.username.trim() : "",
      domain: d.type === "smb" ? d.domain.trim() : "",
      ...(d.type === "smb" && d.username.trim() && (e.password || !e.editing) ? { password: e.password } : {}),
    };
  }

  async function runTest() {
    if (!editor) return;
    setTest({ ok: false, running: true });
    try {
      setTest(await storageWrite<StorageTest>("/test", payload(editor)));
    } catch (e) {
      setTest({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function save() {
    if (!editor) return;
    const body = payload(editor);
    if (await act(t("storage.saving", { p0: String(body.name) }), () => storageWrite("", body))) {
      setEditor(undefined);
      setTest(undefined);
    }
  }

  const locked = busy || !!pending || stale;
  const storages = state?.storages ?? [];
  const missingTools = state && (!state.tools.smb || !state.tools.nfs);
  const selectedStorage = storages.find((s) => s.id === selectedID) ?? storages.find((s) => s.mounted) ?? storages[0];
  // The mount unit only records that it failed; a saved-connection test returns the NAS's reason.
  const testSaved = (s: Storage) => {
    setConnectionTest(undefined);
    void act(t("storage.testing", { p0: String(s.name) }), async () => {
      const result = await storageWrite<StorageTest>("/test", { id: s.id, type: s.type, server: s.server, share: s.share, domain: s.domain, username: s.username, version: s.version });
      setConnectionTest({ id: s.id, result });
    });
  };

  return (
    <div className="flex flex-col gap-6">
    <PageHeading page="storage" action={!editor && storages.length > 0 && <Button disabled={locked || storages.length >= 8} onClick={() => openEditor()}><Plus />{t("storage.addNas")}</Button>} />
    {stale && state && <Notice warning>{t("storage.couldnTRefreshNetworkStorageShowing")}</Notice>}
    <NasDiskPanel disk={disk} locked={locked} />
    <section role="region" aria-label={t("nav.storage")} className="@container min-w-0 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          {(pending || (!disk.hasActivity && disk.pending)) && (
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground" role="status">
              <Spinner />
              {pending || disk.pending}
            </span>
          )}
        </div>
      <div className="flex flex-col gap-5 empty:hidden">
      {missingTools && (
        <p className="rounded-md border border-warning/30 bg-warning/5 p-3 text-sm text-warning-foreground">
          {t("storage.missingTools", { tools: [!state.tools.smb && "SMB (cifs-utils)", !state.tools.nfs && "NFS (nfs-common)"].filter(Boolean).join(" / ") })}</p>
      )}

      {editor && !editor.editing && (
        <StorageEditor
          editor={editor}
          setEditor={setEditor}
          test={test}
          tools={state?.tools}
          locked={locked}
          onTest={() => void runTest()}
          onSave={() => void save()}
          onCancel={() => (setEditor(undefined), setTest(undefined))}
        />
      )}

      {state === undefined ? (
        <PanelSkeleton label={stale ? t("common.loading") : ""} />
      ) : storages.length === 0 && !editor ? (
        <EmptyState icon={Server} action={<Button variant="default" disabled={locked} onClick={() => openEditor()}>{t("storage.addNas")}</Button>}>
          <strong className="font-medium text-foreground">{t("storage.noNasConnectionsYet")}</strong><br />{t("storage.addANasToSaveRecordings")}</EmptyState>
      ) : (
        <FadeIn><AnimatedList className="flex min-w-0 flex-col gap-3 [&>li]:min-w-0" label={t("storage.nasConnections")} items={storages} getKey={(s) => s.id}>{(s) => {
            const connection = stateLabel(s);
            const room = capacity(s);
            const open = editor?.editing && editor.draft.id === s.id;
            const inUse = session?.storage === s.id;
            return (
              <div className={`rounded-xl border p-5 ${s.id === selectedStorage?.id ? "border-chart-1/40 bg-chart-1/3" : "bg-card"} ${open ? "space-y-5" : ""}`}>
                <div className="flex min-w-0 flex-wrap items-start gap-3">
                  <div className="rounded-lg bg-chart-1/8 p-3 text-chart-1"><Server className="size-5" aria-hidden="true" /></div>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2 [&_strong]:font-medium">
                      <button type="button" className="rounded-sm text-left text-base font-semibold outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50" aria-pressed={s.id === selectedStorage?.id} aria-label={t("storage.viewConnectionDetailsFor", { p0: String(s.name) })} onClick={() => setSelectedID(s.id)}>{s.name}</button>
                      <StatusDot tone={connection.tone} />
                      <Badge variant="secondary">{s.type.toUpperCase()}</Badge>
                      {s.autoMount && <Badge variant="secondary">{t("storage.connectAutomatically")}</Badge>}
                      {s.insecure && <Badge variant="secondary" className="bg-warning/15 text-warning-foreground">SMB 1.0</Badge>}
                      <span className="text-sm text-muted-foreground">{connection.text}</span>
                      {inUse && <Badge variant="secondary">{t("storage.usbDriveInUse")}</Badge>}
                    </div>
                    <span className="text-xs text-muted-foreground font-mono break-all">{storageAddress(s)}</span>
                    {room && (
                      <div className="flex max-w-xl flex-col gap-2 pt-2 text-xs">
                        {room.ratio !== undefined && (
                          <span className={`block h-2 w-full overflow-hidden rounded-full bg-muted [&>span]:block [&>span]:h-full [&>span]:rounded-full${room.ratio > 0.95 ? " [&>span]:bg-destructive-fill" : room.ratio > 0.85 ? " [&>span]:bg-warning" : " [&>span]:bg-chart-1"}`}>
                            <span style={{ width: `${Math.max(2, room.ratio * 100)}%` }} />
                          </span>
                        )}
                        <span className="text-muted-foreground">{room.text}</span>
                      </div>
                    )}
                    {s.mounted && s.writable === false && (
                      <span className="text-sm text-warning-foreground">{t("storage.theBoardDoesnTHaveWrite")}</span>
                    )}
                    {!s.mounted && s.error && <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                      <span className="text-destructive">{s.error}</span>
                      {connectionTest?.id !== s.id && <Button variant="link" size="inline" disabled={locked} onClick={() => testSaved(s)}>{t("storage.viewDetails")}</Button>}
                    </span>}
                    {connectionTest?.id === s.id && <p role="status" className={`text-sm ${connectionTest.result.ok ? "text-success-foreground" : "text-destructive"}`}>{connectionTest.result.ok ? t("storage.connectionTestPassedYouCanReconnect") : t("storage.connectionTestFailed", { p0: String(connectionTest.result.error || t("storage.nasUnavailable")) })}</p>}
                  </div>
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    {s.mounted ? (
                      <Button variant="outline"
                        disabled={locked || !!disk.pending || !disk.state?.known || !!session}
                        title={session ? t("storage.onlyOneUsbDriveCanBe") : undefined}
                        aria-expanded={diskSetup === s.id}
                        onClick={() => {
                          setDiskSetup(s.id);
                          setSelectedID(s.id);
                          setEditor(undefined);
                          setConfirming(undefined);
                        }}
                      >
                        {t("storage.useAsUsbDrive")}</Button>
                    ) : (
                      <Button variant="outline"
                        disabled={locked || s.state === "mounting"}
                        onClick={() => void act(t("storage.connectingTo", { p0: String(s.name) }), () => storageWrite("/mount", { id: s.id }))}
                      >
                        {t("storage.connect")}</Button>
                    )}
                    <Button variant="outline" disabled={locked} onClick={() => { setSelectedID(s.id); openEditor(s); }}><Pencil />{t("storage.editConnection")}</Button>
                    <StorageMenu storage={s} locked={locked} inUse={inUse}
                      onEdit={() => (open ? setEditor(undefined) : openEditor(s))}
                      onConfirm={(kind) => setConfirming({ kind, storage: s })} />
                  </div>
                </div>

                {diskSetup === s.id && s.mounted && !session && (
                  <NasDiskSetup key={s.id} storage={s}
                    locked={locked || !!disk.pending || !disk.state?.known}
                    onCancel={() => setDiskSetup(undefined)}
                    onStart={(setup) => void disk.act(t("storage.preparingUsbDrive"), () => nasDiskWrite("/start", {
                      storage: setup.storage, path: setup.path, mode: setup.mode, label: setup.label,
                      utcOffsetMinutes: -new Date().getTimezoneOffset(),
                    })).then((ok) => { if (ok) setDiskSetup(undefined); })} />
                )}

                {open && (
                  <>
                    <FactGrid cols={1}><Fact label={t("storage.pathOnBoard")} value={<span className="flex min-w-0 items-center gap-2">
                      <code className="font-mono break-all">{s.path}</code><CopyButton text={s.path} label={t("storage.copyPath")} />
                    </span>} /></FactGrid>
                    <StorageEditor
                      editor={editor}
                      setEditor={setEditor}
                      test={test}
                      tools={state.tools}
                      locked={locked}
                      onTest={() => void runTest()}
                      onSave={() => void save()}
                      onCancel={() => (setEditor(undefined), setTest(undefined))}
                    />
                  </>
                )}

                {confirming?.storage.id === s.id && (
                  <ConfirmDialog open onOpenChange={(open) => { if (!open) setConfirming(undefined); }}
                    title={confirming.kind === "delete" ? t("storage.deleteConnection") : t("storage.disconnect")}
                    description={confirming.kind === "delete"
                      ? t(s.mounted ? "storage.deleteConnectedWarning" : "storage.deleteWarning", { name: s.name })
                      : t("storage.disconnectStopAnyRecordingsOrSafely", { p0: String(s.name) })}
                    confirm={confirming.kind === "delete" ? t("storage.deleteConnection") : t("storage.disconnect")} destructive disabled={locked || inUse}
                    onConfirm={() => void (confirming.kind === "delete"
                      ? act(t("storage.deleting", { p0: String(s.name) }), () => storageWrite("/delete", { id: s.id, confirm: s.name })).then((ok) => ok && setEditor(undefined))
                      : act(t("storage.disconnecting", { p0: String(s.name) }), () => storageWrite("/unmount", { id: s.id })))} />
                )}
              </div>
            );
          }}</AnimatedList></FadeIn>
      )}

      {error && (
        <InlineError>
          {error}
        </InlineError>
      )}
      {!disk.hasActivity && disk.state && !disk.state.known && <p className="text-sm text-warning-foreground">{t("nasDisk.couldnTReadTheUsbDrive")}</p>}
      {!disk.hasActivity && disk.error && <InlineError>{disk.error}</InlineError>}
    </div></section>
    {selectedStorage && <SettingsCard title={t("storage.connectionDetails", { p0: String(selectedStorage.name) })}>
      <FactGrid cols={2}>
        <Fact label={t("storage.protocol")} value={`${selectedStorage.type.toUpperCase()}${selectedStorage.version === "auto" ? t("storage.automatic327") : ` ${selectedStorage.version}`}`} />
        <Fact label={t("login.username")} value={selectedStorage.type === "smb" ? selectedStorage.username || t("storage.guest") : "—"} />
        <Fact label={t("storage.share")} value={selectedStorage.share} />
        <Fact label={t("storage.connectAtBoot")} value={selectedStorage.autoMount ? t("storage.on") : t("storage.off")} />
        <Fact label={t("storage.server")} value={selectedStorage.server} />
        <Fact label={t("storage.access")} value={!selectedStorage.mounted || selectedStorage.writable == null ? t("common.unknown") : selectedStorage.writable ? t("storage.readAndWrite") : t("nasDisk.readOnly")} />
      </FactGrid>
      <div className="space-y-4"><div className="flex flex-wrap gap-3">
        <Button variant="outline" disabled={locked} onClick={() => testSaved(selectedStorage)}>{t("storage.testSavedConnection")}</Button>
        {selectedStorage.mounted && <Button variant="outline" disabled={locked || session?.storage === selectedStorage.id} onClick={() => setConfirming({ kind: "unmount", storage: selectedStorage })}>{t("storage.disconnect339")}</Button>}
      </div>
      <Notice>{t("storage.disconnectingRemovesTheConnectionWithoutDeleting")}</Notice></div>
    </SettingsCard>}
    </div>
  );
}

function StorageMenu({ storage, locked, inUse, onEdit, onConfirm }: {
  storage: Storage;
  locked: boolean;
  inUse: boolean;
  onEdit: () => void;
  onConfirm: (kind: Confirm["kind"]) => void;
}) {
  return <DropdownMenu modal={false}>
    <DropdownMenuTrigger asChild>
      <Button variant="outline" aria-label={t("storage.moreActionsFor", { p0: String(storage.name) })} disabled={locked}><MoreHorizontal aria-hidden="true" className="size-4" /></Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent loop align="end" aria-label={t("storage.actionsFor", { p0: String(storage.name) })}>
      <DropdownMenuItem disabled={locked} onSelect={onEdit}>{t("storage.edit")}</DropdownMenuItem>
      {storage.mounted && <DropdownMenuItem disabled={locked || inUse} title={inUse ? t("storage.aUsbDriveIsUsingThis") : undefined} onSelect={() => onConfirm("unmount")}>{t("storage.disconnect")}</DropdownMenuItem>}
      <DropdownMenuItem disabled={locked || inUse} title={inUse ? t("storage.aUsbDriveIsUsingThis") : undefined} onSelect={() => onConfirm("delete")}>{t("disk.delete73")}</DropdownMenuItem>
      {inUse && <p className="px-2 py-1 text-xs text-muted-foreground">{t("storage.aUsbDriveIsUsingThis")}</p>}
    </DropdownMenuContent>
  </DropdownMenu>;
}

function StorageEditor({
  editor,
  setEditor,
  test,
  tools,
  locked,
  onTest,
  onSave,
  onCancel,
}: {
  editor: Editor;
  setEditor: (e: Editor) => void;
  test?: StorageTest & { running?: boolean };
  tools?: { smb: boolean; nfs: boolean };
  locked: boolean;
  onTest: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const d = editor.draft;
  const set = (patch: Partial<StorageConfig>) => setEditor({ ...editor, draft: { ...d, ...patch } });
  const invalid = draftError(d);
  const smb = d.type === "smb";
  const toolMissing = tools && !tools[d.type];

  return (
    <form
      className="flex min-w-0 flex-col gap-4 rounded-md border bg-muted/40 p-4 [&_select]:h-8 [&_select]:rounded-md [&_select]:border [&_select]:border-input [&_select]:bg-card [&_select]:px-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid && !locked) onSave();
      }}
    >
      {!editor.editing && (
        <Segmented label={t("storage.protocol")} className="max-sm:grid-cols-1">
          <SegmentedOption title="SMB" detail={t("storage.windowsMacosAndMostNasDevices")} pressed={smb} onClick={() => set({ type: "smb", version: "auto" })} />
          <SegmentedOption title="NFS" detail={t("storage.nfsExportsOnLinuxAndNas")} pressed={!smb} onClick={() => set({ type: "nfs", version: "auto", username: "", domain: "" })} />
        </Segmented>
      )}

      <div className="grid min-w-0 gap-4 @lg:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-2 text-sm">
          {t("storage.server")}<Input
            value={d.server}
            autoFocus={!editor.editing}
            autoComplete="off"
            spellCheck={false}
            placeholder={t("storage.orNasLocal")}
            onChange={(e) => set({ server: e.target.value })}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-2 text-sm">
          {smb ? t("storage.shareName") : t("storage.exportPath")}
          <Input
            value={d.share}
            autoComplete="off"
            spellCheck={false}
            placeholder={smb ? t("storage.videoOrVideoKvm") : "/volume1/kvm"}
            aria-invalid={!smb && !!d.share && !d.share.startsWith("/")}
            onChange={(e) => set({ share: e.target.value })}
          />
        </label>
        {smb && (
          <>
            <label className="flex min-w-0 flex-col gap-2 text-sm">
              {t("login.username")}<Input
                value={d.username}
                autoComplete="off"
                spellCheck={false}
                placeholder={t("storage.leaveBlankForGuestAccess")}
                onChange={(e) => set({ username: e.target.value })}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-2 text-sm">
              {t("login.password")}<PasswordInput
                value={editor.password}
                autoComplete="new-password"
                placeholder={editor.editing ? t("storage.leaveBlankToKeepTheCurrent") : ""}
                onChange={(e) => setEditor({ ...editor, password: e.target.value })}
              />
            </label>
          </>
        )}
        <label className="flex min-w-0 flex-col gap-2 text-sm">
          {t("disk.name")}<Input value={d.name} autoComplete="off" placeholder={defaultName(d) || "NAS"} maxLength={40} onChange={(e) => set({ name: e.target.value })} />
        </label>
      </div>

      {(d.server || d.share) && (
        <p className="text-xs break-all text-muted-foreground">
          {t("storage.connectionTarget", { address: storageAddress({ ...d, server: d.server.trim(), share: d.share.trim() }) })}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-start gap-2 text-sm">
          <Checkbox className="mt-0.5" checked={d.autoMount} onCheckedChange={(value) => set({ autoMount: value === true })} />
          {t("storage.connectAtBoot")}</label>
        <Button variant="link" size="inline" type="button" aria-expanded={editor.advanced} onClick={() => setEditor({ ...editor, advanced: !editor.advanced })}>
          {t("storage.advancedOptions")}</Button>
      </div>

      {editor.advanced && (
        <div className="grid min-w-0 gap-4 @lg:grid-cols-2 ">
          <label className="flex min-w-0 flex-col gap-2 text-sm">
            {t("storage.protocolVersion")}<NativeSelect className="w-full" value={d.version} onChange={(e) => set({ version: e.target.value })}>
              {VERSIONS[d.type].map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </NativeSelect>
          </label>
          {smb && (
            <label className="flex min-w-0 flex-col gap-2 text-sm">
              {t("storage.domainWorkgroup")}<Input value={d.domain} autoComplete="off" spellCheck={false} placeholder={t("storage.usuallyLeftBlank")} onChange={(e) => set({ domain: e.target.value })} />
            </label>
          )}
          {smb && d.version === "1.0" && <p className="text-sm text-warning-foreground">{t("storage.smbHasNoEncryptionAndKnown")}</p>}
        </div>
      )}

      {toolMissing && <p className="text-sm text-warning-foreground">{t("storage.toolsUnavailable", { tools: smb ? "SMB" : "NFS" })}</p>}
      {test && <TestResult test={test} />}

      <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
        <Button variant="outline" type="button" onClick={onCancel}>
          {t("common.cancel")}</Button>
        <Button variant="outline" type="button" disabled={locked || !!invalid || !!toolMissing || test?.running} aria-busy={test?.running} onClick={onTest}>
          {test?.running && <Spinner />}
          {t("storage.testConnection")}</Button>
        <Button variant="default" type="submit" disabled={locked || !!invalid || !!toolMissing} title={invalid || undefined}>
          {editor.editing ? t("common.save") : d.autoMount ? t("storage.saveAndConnect") : t("common.save")}
        </Button>
      </div>
    </form>
  );
}

function TestResult({ test }: { test: StorageTest & { running?: boolean } }) {
  if (test.running) return <p className="rounded-md border p-3 text-sm text-muted-foreground">{t("storage.connectingToNasThisMayTake")}</p>;
  if (!test.ok) return <p className="rounded-md border p-3 text-sm text-sm text-destructive">{test.error || t("storage.couldnTConnect")}</p>;
  const parts = [
    test.freeBytes != null && test.totalBytes != null ? t("storage.available", { p0: bytes(Math.max(0, test.totalBytes - test.freeBytes)), p1: bytes(test.totalBytes) }) : "",
    test.elapsedMs != null ? `${test.elapsedMs} ms` : "",
  ].filter(Boolean);
  return (
    <p className={`rounded-md border p-3 text-sm ${test.writable ? "text-sm text-success-foreground" : "text-sm text-warning-foreground"}`}>
      {test.writable ? t("storage.connectedWithWriteAccess") : t("storage.readableWithoutWriteAccess")}
      {parts.length > 0 && <span className="text-muted-foreground"> · {parts.join(" · ")}</span>}
    </p>
  );
}

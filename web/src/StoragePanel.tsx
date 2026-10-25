import { Badge } from "@/components/ui/badge";
import { Segmented, SegmentedOption } from "@/components/Segmented";
import { Spinner } from "@/components/Spinner";
import { FadeIn } from "@/components/Motion";
import { AnimatedList } from "@/components/AnimatedList";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MoreHorizontal, Server } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { Fact, FactGrid } from "@/components/FactGrid";
import { InlineError } from "@/components/InlineError";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingsCard } from "@/components/SettingsCard";
import { StatusDot, type Tone } from "@/components/StatusDot";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useActionStore } from "@/stores/action";
import { useEffect, useState } from "react";
import { nasDiskWrite, request, storageWrite, type Storage, type StorageConfig, type StorageState, type StorageTest, type StorageType } from "./api";
import { bytes } from "./DiskPanel";
import { CopyButton } from "@/components/CopyButton";
import { PasswordInput } from "@/components/PasswordInput";
import { NasDiskPanel, NasDiskSetup, useNasDisk } from "./NasDiskPanel";

const VERSIONS: Record<StorageType, { value: string; label: string }[]> = {
  smb: [
    { value: "auto", label: "自动协商" },
    { value: "3.1.1", label: "SMB 3.1.1" },
    { value: "3.0", label: "SMB 3.0" },
    { value: "2.1", label: "SMB 2.1" },
    { value: "2.0", label: "SMB 2.0" },
    { value: "1.0", label: "SMB 1.0（不安全）" },
  ],
  nfs: [
    { value: "auto", label: "自动协商" },
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
  if (!d.server.trim()) return "填写服务器地址";
  if (!d.share.trim()) return d.type === "smb" ? "填写共享名" : "填写导出路径";
  if (d.type === "nfs" && !d.share.startsWith("/")) return "导出路径以 / 开头";
  return "";
}

function capacity(s: Storage) {
  if (!s.mounted) return undefined;
  if (s.totalBytes == null || s.freeBytes == null) return { text: s.stale ? "NAS 无响应" : "容量未知", ratio: undefined };
  const used = 1 - s.freeBytes / Math.max(1, s.totalBytes);
  return { text: `剩余 ${bytes(s.freeBytes)} / ${bytes(s.totalBytes)}`, ratio: used };
}

function stateLabel(s: Storage): { tone: Tone; text: string } {
  if (s.state === "mounting") return { tone: "warning", text: "正在连接" };
  if (s.mounted && s.stale) return { tone: "warning", text: "已连接 · 无响应" };
  if (s.mounted) return { tone: "good", text: s.writable === false ? "已连接 · 只读" : "已连接" };
  if (s.state === "error") return { tone: "critical", text: "连接失败" };
  return { tone: "idle", text: "未连接" };
}

export function StoragePanel() {
  const busy = useActionStore((s) => !!s.busy);
  const [state, setState] = useState<StorageState>();
  const [stale, setStale] = useState(true);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<Editor>();
  const [test, setTest] = useState<StorageTest & { running?: boolean }>();
  const [confirming, setConfirming] = useState<Confirm>();
  const [diskSetup, setDiskSetup] = useState<string>();
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
  }, [pending]);

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
    if (await act(`正在保存「${body.name}」…`, () => storageWrite("", body))) {
      setEditor(undefined);
      setTest(undefined);
    }
  }

  const locked = busy || !!pending || stale;
  const storages = state?.storages ?? [];
  const missingTools = state && (!state.tools.smb || !state.tools.nfs);

  return (
    <div className="flex flex-col gap-6">
    <NasDiskPanel disk={disk} locked={locked} />
    <SettingsCard label="网络存储" title="NAS" description="断开不会删除 NAS 上的文件。" action={
        <div className="flex flex-wrap items-center gap-3">
          {(pending || (!disk.hasActivity && disk.pending)) && (
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground" role="status">
              <Spinner />
              {pending || disk.pending}
            </span>
          )}
          {!editor && storages.length > 0 && (
            <Button variant="default" disabled={locked || storages.length >= 8} onClick={() => openEditor()}>
              添加 NAS
            </Button>
          )}
        </div>
      }><div className="flex flex-col gap-5 empty:hidden">
      {missingTools && (
        <p className="rounded-md border border-warning/30 bg-warning/5 p-3 text-sm text-warning-foreground">
          板子缺少{[!state.tools.smb && "SMB（cifs-utils）", !state.tools.nfs && "NFS（nfs-common）"].filter(Boolean).join("、")}
          挂载工具，请先在「更新」页更新管理面板。
        </p>
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
        <PanelSkeleton label={stale ? "正在读取…" : ""} />
      ) : storages.length === 0 && !editor ? (
        <EmptyState icon={Server} action={<Button variant="default" disabled={locked} onClick={() => openEditor()}>添加 NAS</Button>}>
          <strong className="font-medium text-foreground">还没有 NAS</strong><br />添加后可以把录屏保存到 NAS，或把 NAS 上的文件夹作为 U 盘交给被控电脑。
        </EmptyState>
      ) : (
        <FadeIn><AnimatedList className="flex min-w-0 flex-col divide-y [&>li]:flex [&>li]:flex-col [&>li]:gap-4 [&>li]:py-4 [&>li:first-child]:pt-0 [&>li:last-child]:pb-0" label="NAS 连接" items={storages} getKey={(s) => s.id}>{(s) => {
            const connection = stateLabel(s);
            const room = capacity(s);
            const open = editor?.editing && editor.draft.id === s.id;
            const inUse = session?.storage === s.id;
            return (
              <div className={open ? "bg-accent" : undefined}>
                <div className="flex min-w-0 flex-wrap items-start gap-3">
                  <StatusDot tone={connection.tone} className="mt-1.5" />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2 [&_strong]:font-medium">
                      <strong>{s.name}</strong>
                      <Badge variant="secondary">{s.type.toUpperCase()}</Badge>
                      {s.insecure && <Badge variant="secondary" className="bg-warning/15 text-warning-foreground">SMB 1.0</Badge>}
                      <span className="text-sm text-muted-foreground">{connection.text}</span>
                      {inUse && <Badge variant="secondary">U 盘使用中</Badge>}
                    </div>
                    <span className="text-xs text-muted-foreground font-mono break-all">{storageAddress(s)}</span>
                    {room && (
                      <div className="flex max-w-sm flex-col gap-2 text-xs">
                        {room.ratio !== undefined && (
                          <span className={`block h-1.5 w-full overflow-hidden rounded-full bg-primary/10 [&>span]:block [&>span]:h-full [&>span]:rounded-full${room.ratio > 0.95 ? " [&>span]:bg-destructive-fill" : room.ratio > 0.85 ? " [&>span]:bg-warning" : " [&>span]:bg-primary"}`}>
                            <span style={{ width: `${Math.max(2, room.ratio * 100)}%` }} />
                          </span>
                        )}
                        <span className="text-muted-foreground">{room.text}</span>
                      </div>
                    )}
                    {s.mounted && s.writable === false && (
                      <span className="text-sm text-warning-foreground">板子没有写入权限，录制和 U 盘回写不可用。请在 NAS 上给该账户写入权限。</span>
                    )}
                    {!s.mounted && s.error && <span className="text-sm text-destructive">{s.error}</span>}
                  </div>
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    {s.mounted ? (
                      <Button variant="outline"
                        disabled={locked || !!disk.pending || !disk.state?.known || !!session}
                        title={session ? "同一时间只能有一个 U 盘" : undefined}
                        aria-expanded={diskSetup === s.id}
                        onClick={() => {
                          setDiskSetup(s.id);
                          setEditor(undefined);
                          setConfirming(undefined);
                        }}
                      >
                        作为 U 盘…
                      </Button>
                    ) : (
                      <Button variant="outline"
                        disabled={locked || s.state === "mounting"}
                        onClick={() => void act(`正在连接「${s.name}」…`, () => storageWrite("/mount", { id: s.id }))}
                      >
                        连接
                      </Button>
                    )}
                    <StorageMenu storage={s} locked={locked} inUse={inUse}
                      onEdit={() => (open ? setEditor(undefined) : openEditor(s))}
                      onConfirm={(kind) => setConfirming({ kind, storage: s })} />
                  </div>
                </div>

                {diskSetup === s.id && s.mounted && !session && (
                  <NasDiskSetup key={s.id} storage={s}
                    locked={locked || !!disk.pending || !disk.state?.known}
                    onCancel={() => setDiskSetup(undefined)}
                    onStart={(setup) => void disk.act("正在准备 U 盘…", () => nasDiskWrite("/start", {
                      storage: setup.storage, path: setup.path, mode: setup.mode, label: setup.label,
                      utcOffsetMinutes: -new Date().getTimezoneOffset(),
                    })).then((ok) => { if (ok) setDiskSetup(undefined); })} />
                )}

                {open && (
                  <>
                    <FactGrid cols={1}><Fact label="板上路径" value={<span className="flex min-w-0 items-center gap-2">
                      <code className="font-mono break-all">{s.path}</code><CopyButton text={s.path} label="复制路径" />
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
                    title={confirming.kind === "delete" ? "删除连接" : "断开"}
                    description={confirming.kind === "delete"
                      ? `删除「${s.name}」的连接设置和保存的密码${s.mounted ? "，并先断开" : ""}。NAS 上的文件不受影响。`
                      : `断开「${s.name}」。正在使用它的录制或 U 盘会阻止断开，需先停止录制或安全弹出。`}
                    confirm={confirming.kind === "delete" ? "删除连接" : "断开"} destructive disabled={locked || inUse}
                    onConfirm={() => void (confirming.kind === "delete"
                      ? act(`正在删除「${s.name}」…`, () => storageWrite("/delete", { id: s.id, confirm: s.name })).then((ok) => ok && setEditor(undefined))
                      : act(`正在断开「${s.name}」…`, () => storageWrite("/unmount", { id: s.id })))} />
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
      {!disk.hasActivity && disk.state && !disk.state.known && <p className="text-sm text-warning-foreground">暂时无法读取 U 盘状态。</p>}
      {!disk.hasActivity && disk.error && <InlineError>{disk.error}</InlineError>}
    </div></SettingsCard>
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
      <Button variant="outline" aria-label={`${storage.name} 的更多操作`} disabled={locked}><MoreHorizontal aria-hidden="true" className="size-4" /></Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent loop align="end" aria-label={`${storage.name} 的操作`}>
      <DropdownMenuItem disabled={locked} onSelect={onEdit}>编辑</DropdownMenuItem>
      {storage.mounted && <DropdownMenuItem disabled={locked || inUse} title={inUse ? "U 盘正在使用此 NAS" : undefined} onSelect={() => onConfirm("unmount")}>断开</DropdownMenuItem>}
      <DropdownMenuItem disabled={locked || inUse} title={inUse ? "U 盘正在使用此 NAS" : undefined} onSelect={() => onConfirm("delete")}>删除</DropdownMenuItem>
      {inUse && <p className="px-2 py-1 text-xs text-muted-foreground">U 盘正在使用此 NAS</p>}
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
        <Segmented label="协议" className="max-sm:grid-cols-1">
          <SegmentedOption title="SMB" detail="Windows、macOS、大多数 NAS" pressed={smb} onClick={() => set({ type: "smb", version: "auto" })} />
          <SegmentedOption title="NFS" detail="Linux 与 NAS 的 NFS 导出" pressed={!smb} onClick={() => set({ type: "nfs", version: "auto", username: "", domain: "" })} />
        </Segmented>
      )}

      <div className="grid min-w-0 gap-4 @lg:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-2 text-sm">
          服务器
          <Input
            value={d.server}
            autoFocus={!editor.editing}
            autoComplete="off"
            spellCheck={false}
            placeholder="192.168.1.10 或 nas.local"
            onChange={(e) => set({ server: e.target.value })}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-2 text-sm">
          {smb ? "共享名" : "导出路径"}
          <Input
            value={d.share}
            autoComplete="off"
            spellCheck={false}
            placeholder={smb ? "video 或 video/kvm" : "/volume1/kvm"}
            aria-invalid={!smb && !!d.share && !d.share.startsWith("/")}
            onChange={(e) => set({ share: e.target.value })}
          />
        </label>
        {smb && (
          <>
            <label className="flex min-w-0 flex-col gap-2 text-sm">
              用户名
              <Input
                value={d.username}
                autoComplete="off"
                spellCheck={false}
                placeholder="留空为访客访问"
                onChange={(e) => set({ username: e.target.value })}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-2 text-sm">
              密码
              <PasswordInput
                value={editor.password}
                autoComplete="new-password"
                placeholder={editor.editing ? "留空则不修改" : ""}
                onChange={(e) => setEditor({ ...editor, password: e.target.value })}
              />
            </label>
          </>
        )}
        <label className="flex min-w-0 flex-col gap-2 text-sm">
          名称
          <Input value={d.name} autoComplete="off" placeholder={defaultName(d) || "NAS"} maxLength={40} onChange={(e) => set({ name: e.target.value })} />
        </label>
      </div>

      {(d.server || d.share) && (
        <p className="text-xs break-all text-muted-foreground">
          将连接 <code className="font-mono break-all">{storageAddress({ ...d, server: d.server.trim(), share: d.share.trim() })}</code>
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-start gap-2 text-sm [&_input]:mt-1">
          <input className="accent-primary" type="checkbox" checked={d.autoMount} onChange={(e) => set({ autoMount: e.target.checked })} />
          开机自动连接
        </label>
        <Button variant="link" size="inline" type="button" aria-expanded={editor.advanced} onClick={() => setEditor({ ...editor, advanced: !editor.advanced })}>
          高级选项
        </Button>
      </div>

      {editor.advanced && (
        <div className="grid min-w-0 gap-4 @lg:grid-cols-2 ">
          <label className="flex min-w-0 flex-col gap-2 text-sm">
            协议版本
            <select value={d.version} onChange={(e) => set({ version: e.target.value })}>
              {VERSIONS[d.type].map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          {smb && (
            <label className="flex min-w-0 flex-col gap-2 text-sm">
              域 / 工作组
              <Input value={d.domain} autoComplete="off" spellCheck={false} placeholder="通常留空" onChange={(e) => set({ domain: e.target.value })} />
            </label>
          )}
          {smb && d.version === "1.0" && <p className="text-sm text-warning-foreground">SMB 1.0 没有加密且存在已知漏洞，只在老旧设备无法升级时使用。</p>}
        </div>
      )}

      {toolMissing && <p className="text-sm text-warning-foreground">板子缺少 {smb ? "SMB" : "NFS"} 挂载工具，暂时无法连接。</p>}
      {test && <TestResult test={test} />}

      <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
        <Button variant="outline" type="button" onClick={onCancel}>
          取消
        </Button>
        <Button variant="outline" type="button" disabled={locked || !!invalid || !!toolMissing || test?.running} aria-busy={test?.running} onClick={onTest}>
          {test?.running && <Spinner />}
          测试连接
        </Button>
        <Button variant="default" type="submit" disabled={locked || !!invalid || !!toolMissing} title={invalid || undefined}>
          {editor.editing ? "保存" : d.autoMount ? "保存并连接" : "保存"}
        </Button>
      </div>
    </form>
  );
}

function TestResult({ test }: { test: StorageTest & { running?: boolean } }) {
  if (test.running) return <p className="rounded-md border p-3 text-sm text-muted-foreground">正在连接 NAS，最长约 15 秒…</p>;
  if (!test.ok) return <p className="rounded-md border p-3 text-sm text-sm text-destructive">{test.error || "连接失败"}</p>;
  const parts = [
    test.freeBytes != null && test.totalBytes != null ? `剩余 ${bytes(test.freeBytes)} / ${bytes(test.totalBytes)}` : "",
    test.elapsedMs != null ? `${test.elapsedMs} ms` : "",
  ].filter(Boolean);
  return (
    <p className={`rounded-md border p-3 text-sm ${test.writable ? "text-sm text-success-foreground" : "text-sm text-warning-foreground"}`}>
      {test.writable ? "连接成功，可以写入" : "可以读取，但没有写入权限"}
      {parts.length > 0 && <span className="text-muted-foreground"> · {parts.join(" · ")}</span>}
    </p>
  );
}

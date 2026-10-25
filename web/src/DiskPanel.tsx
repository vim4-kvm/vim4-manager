import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { File, Folder, HardDrive } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { InlineError } from "@/components/InlineError";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingsCard } from "@/components/SettingsCard";
import { StatusLabel } from "@/components/StatusDot";
import { useActionStore, report } from "@/stores/action";
import { useStatusStore } from "@/stores/status";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type DragEvent, type ReactNode } from "react";
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
const LEAVE_UPLOAD = "正在上传，离开会中断上传。确定离开？";

export function bytes(value: number): string {
  if (value >= 2 ** 40) return `${(value / 2 ** 40).toFixed(1)} TiB`;
  if (value >= 2 ** 30) return `${(value / 2 ** 30).toFixed(1)} GiB`;
  if (value >= 2 ** 20) return `${(value / 2 ** 20).toFixed(1)} MiB`;
  if (value >= 2 ** 10) return `${(value / 2 ** 10).toFixed(0)} KiB`;
  return `${value} B`;
}

function when(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);
const parent = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const validName = (name: string) => !!name && name !== "." && name !== ".." && !/[\\/:*?"<>|\x00-\x1f\x7f-\x9f]/.test(name) && name.length <= 255;
export const normalizeLabel = (label: string) => label.toUpperCase().replace(/[^A-Z0-9 _-]/g, "").slice(0, 11);

function DiskIcon() { return <HardDrive aria-hidden="true" className="size-4 shrink-0 text-primary" />; }
function FileIcon({ dir }: { dir: boolean }) {
  const Icon = dir ? Folder : File;
  return <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />;
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

function Action({ working, className = "text-xs", children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { working?: boolean }) {
  return (
    <Button variant="outline" className={className} aria-busy={working || undefined} {...props}>
      {working && <span className="inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />}
      {children}
    </Button>
  );
}

// Two-click destructive button; disarms on blur or after a few seconds.
function ArmedButton({ label, armedLabel, ariaLabel, disabled, working, onConfirm }: {
  label: string; armedLabel: string; ariaLabel: string; disabled: boolean; working: boolean; onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <Action
      className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 text-xs ${armed ? " border-destructive/30 text-destructive hover:bg-destructive/10 " : ""}`}
      aria-label={armed ? undefined : ariaLabel}
      disabled={disabled}
      working={working}
      onBlur={() => setArmed(false)}
      onClick={() => (armed ? onConfirm() : setArmed(true))}
    >
      <span className="[&>span[aria-hidden=true]]:hidden">
        <span aria-hidden={armed}>{label}</span>
        <span aria-hidden={!armed}>{armedLabel}</span>
      </span>
    </Action>
  );
}

function DiskState({ disk }: { disk: Disk }) {
  return <StatusLabel tone={disk.attached ? "idle" : disk.editing ? "warning" : "good"}>
    {disk.attached ? disk.readOnly ? "已挂载（只读）" : "已挂载到被控电脑" : disk.editing ? "正在编辑" : "空闲"}
  </StatusLabel>;
}

function Usage({ disk }: { disk: Disk }) {
  if (disk.freeBytes == null) return <span className="text-muted-foreground">无法读取文件系统</span>;
  const used = Math.max(0, disk.size - disk.freeBytes);
  const percent = Math.min(100, (used / disk.size) * 100);
  return (
    <span className={`flex flex-col gap-2 text-xs text-muted-foreground${disk.freeBytes < disk.size * 0.1 ? " [&>span>span]:bg-warning" : ""}`}>
      <span className="block h-1 w-full overflow-hidden rounded-full bg-primary/10 [&>span]:block [&>span]:h-full [&>span]:bg-primary" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </span>
      <span className="tabular-nums">剩余 {bytes(disk.freeBytes)} / {bytes(disk.size)}</span>
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
  const invalid = !/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(name.trim()) ? "名称只能包含字母、数字、点、下划线和短横线，且以字母或数字开头。"
    : disks.some((disk) => disk.name.toLowerCase() === file.toLowerCase()) ? "已有同名数据盘。"
    : !label.trim() ? "卷标不能为空。"
    : sizeMiB < 64 || sizeMiB > 32768 ? "容量需在 64 MiB 到 32 GiB 之间。"
    : undefined;

  if (!open) {
    return (
      <Button variant="outline" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 text-xs" disabled={busy || disks.length >= 8} onClick={() => setOpen(true)}>
        新建数据盘
      </Button>
    );
  }
  return (
    <form
      className="flex w-full min-w-0 flex-col gap-4 rounded-md border bg-muted/40 p-4 "
      onKeyDown={(event) => { if (event.key === "Escape" && !busy) setOpen(false); }}
      onSubmit={(event) => {
        event.preventDefault();
        if (invalid) return;
        void track("create")(`正在创建 ${file}…`, () => request("/api/disks", { name: file, sizeMiB, label: label.trim() }), `数据盘 ${file} 已创建`)
          .then((ok) => { if (ok) { setOpen(false); setName(""); onCreated(file); } });
      }}
    >
      <label className="flex min-w-0 flex-col gap-2 text-sm">
        <span>名称</span>
        <span className="flex items-center gap-2">
          <Input autoFocus value={name} disabled={busy} maxLength={60} placeholder="tools" onChange={(event) => setName(event.target.value)} />
          <span className="text-muted-foreground">.img</span>
        </span>
      </label>
      <label className="flex min-w-0 flex-col gap-2 text-sm">
        <span>卷标</span>
        <Input value={label} disabled={busy} onChange={(event) => setLabel(normalizeLabel(event.target.value))} />
      </label>
      <fieldset className="flex min-w-0 flex-col gap-2 text-sm flex flex-wrap gap-2 [&_legend]:mb-2">
        <legend>容量</legend>
        {SIZES.map((size) => (
          <label key={size} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 has-checked:border-primary has-checked:bg-primary/5${size === sizeMiB ? " border-primary bg-primary/5" : ""}`}>
            <input className="accent-primary" type="radio" name="disk-size" checked={size === sizeMiB} disabled={busy} onChange={() => setSizeMiB(size)} />
            {bytes(size * 2 ** 20)}
          </label>
        ))}
      </fieldset>
      <p className="text-sm text-muted-foreground">FAT32 文件系统，Windows、macOS 与 Linux 均可直接读写；单个文件不能超过 4 GiB。空间立即在板子上分配。</p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {invalid && name && <span className="text-destructive">{invalid}</span>}
        <Button variant="outline" type="button" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
        <Action type="submit" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 border-primary bg-primary text-primary-foreground hover:bg-primary/90" working={doing === "create"} disabled={busy || !!invalid}>创建</Action>
      </div>
    </form>
  );
}

function duration(seconds: number): string {
  return seconds < 60 ? `约 ${Math.max(1, Math.round(seconds))} 秒` : `约 ${Math.round(seconds / 60)} 分钟`;
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
        {finished ? <span className="text-success" aria-hidden="true">✓</span> : <span className="inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />}
        <strong>
          {finished ? `已上传 ${uploads.length} 个文件` : writing ? `正在写入 ${current.file.name}…` : `正在上传 ${current.file.name}`}
        </strong>
        {!finished && uploads.length > 1 && <span className="tabular-nums text-muted-foreground">第 {index + 1}/{uploads.length} 个</span>}
        <span className="tabular-nums text-muted-foreground">{bytes(sent)} / {bytes(total)}</span>
        {!finished && <Button variant="outline" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 text-xs" onClick={onCancel}>取消</Button>}
      </div>
      <span className="block h-1.5 w-full overflow-hidden rounded-full bg-primary/10 [&>span]:block [&>span]:h-full [&>span]:bg-primary" role="progressbar" aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={sent}>
        <span style={{ width: `${total ? (sent / total) * 100 : 100}%` }} />
      </span>
      {!finished && (
        <p className="text-sm text-muted-foreground tabular-nums">
          {rate > 0 && `${bytes(rate)}/s · 剩余${duration((total - sent) / rate)} · `}
          文件先完整传到板子，再写入数据盘；离开此页会中断上传。
        </p>
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
  if (disk.attached) return "数据盘挂载在被控电脑上，不能上传";
  if (disk.editing) return "数据盘正在编辑，暂时不能上传";
  if (uploading) return "正在上传，完成后再拖入";
  if (busy) return "正在处理其他操作，稍后再拖入";
  if (!loaded) return "文件列表加载中，稍后再拖入";
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
  const [renaming, setRenaming] = useState<string>();
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
  const crumbs = path === "/" ? [] : path.slice(1).split("/");
  const blocked = dropBlocked(disk, busy, uploading, !!entries);

  useEffect(() => {
    if (!uploading) return;
    const unload = (event: BeforeUnloadEvent) => event.preventDefault();
    const leave = (event: MouseEvent) => {
      const link = (event.target as Element).closest?.("a[href^='#/']");
      if (link && link.getAttribute("href") !== "#/disks" && !window.confirm(LEAVE_UPLOAD)) event.preventDefault();
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
      report("good", `已上传 ${done} 个文件到 ${disk.name}`);
    } catch (e) {
      const cancelled = e instanceof DOMException && e.name === "AbortError";
      report("critical", cancelled ? `已取消上传；${done} 个文件已完成` : `${(e as Error).message}；${done} 个文件已完成`);
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
    if (!entries) return report("critical", "文件列表尚未加载，请稍后再上传");
    const tooLarge = files.find((file) => file.size > FAT_FILE_LIMIT);
    if (tooLarge) return report("critical", `${tooLarge.name} 超过 FAT32 单个文件 4 GiB 上限`);
    const badName = files.find((file) => !validName(file.name));
    if (badName) return report("critical", `文件名「${badName.name}」不能用于 FAT 文件系统`);
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (disk.freeBytes != null && total > disk.freeBytes) {
      return report("critical", `空间不足：需要 ${bytes(total)}，剩余 ${bytes(disk.freeBytes)}`);
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
      className={`flex min-w-0 flex-col gap-4 ${dragging ? " ring-2 ring-primary" : ""}${blocked ? " " : ""}`}
      aria-label="文件"
      data-dragging={dragging || undefined}
      data-drop={blocked ?? "松开以上传到当前文件夹"}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = blocked ? "none" : "copy";
        setDragging(true);
      }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
      onDrop={onDrop}
    ><div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 [&_h3]:text-sm [&_h3]:font-semibold">
        <h3>文件</h3>
        <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1" aria-label="路径">
          <Button variant="outline" className="h-auto border-0 bg-transparent px-1 py-0.5 text-xs text-primary disabled:opacity-50" disabled={path === "/"} onClick={() => setPath("/")}>{disk.label || disk.name}</Button>
          {crumbs.map((part, index) => (
            <span key={index}>
              <span className="text-muted-foreground" aria-hidden="true"> / </span>
              <Button variant="outline" className="h-auto border-0 bg-transparent px-1 py-0.5 text-xs text-primary disabled:opacity-50" disabled={index === crumbs.length - 1} onClick={() => setPath("/" + crumbs.slice(0, index + 1).join("/"))}>{part}</Button>
            </span>
          ))}
        </nav>
        <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <Action working={loading && !!listing} disabled={busy || !entries} onClick={() => setReload((value) => value + 1)}>刷新</Action>
          <Button variant="outline" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 text-xs" disabled={locked || !entries} onClick={() => { setFolder(""); }}>新建文件夹</Button>
          <Button variant="outline" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 text-xs border-primary bg-primary text-primary-foreground hover:bg-primary/90" disabled={locked || !entries} onClick={() => input.current?.click()}>上传文件</Button>
          <input ref={input} type="file" multiple hidden onChange={(event) => { chooseFiles(event.target.files); event.target.value = ""; }} />
        </span>
      </div>

      {disk.attached && (
        <p className="rounded-md border border-warning/30 bg-warning/5 p-3 text-sm text-warning-foreground " role="note">
          数据盘正挂载在被控电脑上，此处只能浏览和下载；被控电脑尚未写回的内容不会显示。需要修改时先在被控电脑安全弹出，再到「虚拟介质」页弹出。
        </p>
      )}
      {listing?.stale && !disk.attached && <p className="rounded-md border border-warning/30 bg-warning/5 p-3 text-sm text-warning-foreground" role="note">列表读取时数据盘仍在使用，内容可能不是最新。</p>}

      <Uploads uploads={uploads} started={started} onCancel={() => abort.current?.abort()} />

      {pending && (
        <div className="flex flex-col gap-3 rounded-md border p-4  ">
          <span>当前文件夹已有 {conflicts.map((file) => `「${file.name}」`).join("、")}，是否覆盖？</span>
          <Button variant="outline" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 text-xs" onClick={() => setPending(undefined)}>取消</Button>
          <Button variant="outline" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 text-xs border-destructive/30 text-destructive hover:bg-destructive/10" onClick={() => void startUpload(pending, true)}>覆盖</Button>
        </div>
      )}

      {folder !== undefined && (
        <form
          className="flex w-full min-w-0 flex-wrap items-center gap-2 [&_input]:min-w-24 [&_input]:flex-1 "
          onKeyDown={(event) => { if (event.key === "Escape" && !busy) setFolder(undefined); }}
          onSubmit={(event) => {
            event.preventDefault();
            if (!validName(folder)) return;
            void mutate("mkdir", `正在新建文件夹…`, () => request("/api/disks/mkdir", { disk: disk.name, path: join(path, folder) }), `已新建文件夹 ${folder}`)
              .then((ok) => { if (ok) setFolder(undefined); });
          }}
        >
          <FileIcon dir />
          <Input autoFocus aria-label="文件夹名称" value={folder} disabled={busy} onChange={(event) => setFolder(event.target.value)} />
          <Button variant="outline" type="button" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 text-xs" onClick={() => setFolder(undefined)}>取消</Button>
          <Action type="submit" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 text-xs border-primary bg-primary text-primary-foreground hover:bg-primary/90" working={doing === "mkdir"} disabled={busy || !validName(folder)}>新建</Action>
        </form>
      )}

      {error ? <InlineError>{error}</InlineError>
        : !listing ? <PanelSkeleton />
        : (
          <div className={`min-w-0${loading ? " opacity-60" : ""}`} role="table" aria-label="文件列表" aria-busy={loading}>
            {shown !== "/" && (
              <div className="flex min-w-0 flex-wrap items-center gap-2 border-b py-2" role="row">
                <Button variant="outline" className="flex h-auto min-w-0 flex-1 flex-wrap items-center justify-start gap-2 border-0 bg-transparent p-2 text-left" onClick={() => setPath(parent(shown))}>
                  <FileIcon dir />
                  <span className="min-w-0 flex-1 break-all text-sm">..</span>
                </Button>
              </div>
            )}
            {listing.entries.length === 0 && (
              <EmptyState icon={File}>{readOnly ? "文件夹为空。" : "文件夹为空。把文件拖到这里，或点「上传文件」。"}</EmptyState>
            )}
            {listing.entries.map((entry: DiskEntry) => {
              const target = join(shown, entry.name);
              const open = selected === entry.name;
              return (
                <div key={entry.name} role="row" className={`group/file flex min-w-0 flex-wrap items-center gap-2 border-b py-2${open ? " bg-primary/5" : ""}`}>
                  {renaming === entry.name ? (
                    <form
                      className="flex w-full min-w-0 flex-wrap items-center gap-2 [&_input]:min-w-24 [&_input]:flex-1 "
                      onKeyDown={(event) => { if (event.key === "Escape" && !busy) setRenaming(undefined); }}
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!validName(newName) || newName === entry.name) return;
                        void mutate(`mv:${entry.name}`, "正在重命名…", () => request("/api/disks/mv", { disk: disk.name, from: target, to: join(shown, newName) }), `已重命名为 ${newName}`);
                      }}
                    >
                      <FileIcon dir={entry.dir} />
                      <Input autoFocus aria-label="新名称" value={newName} disabled={busy} onChange={(event) => setNewName(event.target.value)} />
                      <Button variant="outline" type="button" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 text-xs" onClick={() => setRenaming(undefined)}>取消</Button>
                      <Action type="submit" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 text-xs border-primary bg-primary text-primary-foreground hover:bg-primary/90" working={doing === `mv:${entry.name}`} disabled={busy || !validName(newName) || newName === entry.name}>重命名</Action>
                    </form>
                  ) : (
                    <>
                      <Button variant="outline"
                        className="flex h-auto min-w-0 flex-1 flex-wrap items-center justify-start gap-2 border-0 bg-transparent p-2 text-left"
                        aria-expanded={entry.dir ? undefined : open}
                        onClick={() => (entry.dir ? setPath(target) : setSelected(open ? undefined : entry.name))}
                      >
                        <FileIcon dir={entry.dir} />
                        <span className="min-w-0 flex-1 break-all text-sm">{entry.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{entry.dir ? "" : bytes(entry.size)}</span>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums hidden @lg:block">{entry.mtime ? when(entry.mtime) : ""}</span>
                      </Button>
                      <span className={`ml-auto flex flex-wrap items-center justify-end gap-2 ${open ? "" : "invisible group-hover/file:visible group-focus-within/file:visible [@media(hover:none)]:visible"}`}>
                        {!entry.dir && <a className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 text-xs" href={diskFileURL(disk.name, target)} download={entry.name} aria-label={`下载 ${entry.name}`}>下载</a>}
                        {!readOnly && (
                          <>
                            <Button variant="outline" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 text-xs" aria-label={`重命名 ${entry.name}`} disabled={locked} onClick={() => { setRenaming(entry.name); setNewName(entry.name); }}>重命名</Button>
                            <ArmedButton
                              label="删除"
                              armedLabel={entry.dir ? "删除全部内容" : "确认删除"}
                              ariaLabel={`删除 ${entry.name}`}
                              disabled={locked}
                              working={doing === `rm:${entry.name}`}
                              onConfirm={() => void mutate(`rm:${entry.name}`, `正在删除 ${entry.name}…`, () => request("/api/disks/rm", { disk: disk.name, path: target }), `已删除 ${entry.name}`)}
                            />
                          </>
                        )}
                      </span>
                      {open && !entry.dir && (
                        <p className="col-span-full flex flex-wrap gap-x-4 gap-y-1 px-3 pb-3 text-xs text-muted-foreground  tabular-nums">
                          <span>{bytes(entry.size)}{entry.size >= 1024 ? `（${entry.size.toLocaleString("zh-CN")} 字节）` : ""}</span>
                          {entry.mtime ? <span>修改于 {when(entry.mtime)}</span> : null}
                          <span className="w-full break-all font-mono">{target}</span>
                        </p>
                      )}
                    </>
                  )}
                </div>
              );
            })}
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
        <span>输入 <code>{name}</code> 确认</span>
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

function Maintenance({ disk, busy, run, onChanged, onDeleted }: {
  disk: Disk; busy: boolean; run: Run; onChanged: () => void; onDeleted: () => void;
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
    { id: "resize", title: "扩容", text: "保留文件和卷标，扩容前自动创建快照。", button: "扩容…", danger: false,
      disabled: locked || !sizes.length || disk.snapshots.length >= 3 },
    { id: "format", title: "格式化", text: "清空全部文件，保留容量。", button: "格式化…", danger: true, disabled: locked },
    { id: "delete", title: "删除数据盘", text: `删除镜像文件，释放 ${bytes(disk.size)}。`, button: "删除数据盘…", danger: true, disabled: locked },
  ];

  return (
    <SettingsCard
      className="flex min-w-0 flex-col gap-4 "
      aria-label="维护"
      onKeyDown={(event) => { if (event.key === "Escape" && open && !busy) setOpen(undefined); }}
    ><div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 [&_h3]:text-sm [&_h3]:font-semibold">
        <h3>维护</h3>
        <p>{disk.attached ? "数据盘挂载期间不能维护，先在被控电脑安全弹出，再到「虚拟介质」页弹出。" : "以下操作需要数据盘未挂载到被控电脑。"}</p>
      </div>

      <div className="grid gap-4 @xl:grid-cols-2">
        <form
          className="flex min-w-0 flex-col gap-3 rounded-md border p-4 [&_h4]:font-medium"
          onSubmit={(event) => {
            event.preventDefault();
            void act("label", "正在修改卷标…", () => request("/api/disks/label", { name: disk.name, label: label.trim() }), `卷标已改为 ${label.trim()}`);
          }}
        >
          <h4>卷标</h4>
          <p className="text-muted-foreground">被控电脑上显示的名称，最多 11 位大写字母或数字。</p>
          <span className="flex w-full min-w-0 flex-wrap items-center gap-2 [&_input]:min-w-24 [&_input]:flex-1">
            <Input aria-label="卷标" value={label} disabled={locked} onChange={(event) => setLabel(normalizeLabel(event.target.value))} />
            <Action type="submit" working={doing === "label"} disabled={locked || !label.trim() || label.trim() === disk.label}>保存</Action>
          </span>
        </form>

        <div className="flex min-w-0 flex-col gap-3 rounded-md border p-4 [&_h4]:font-medium">
          <h4>检查文件系统</h4>
          <p className="text-muted-foreground">只读检查，不修复。被控电脑异常拔出后建议检查。</p>
          <span className="flex w-full min-w-0 flex-wrap items-center gap-2 [&_input]:min-w-24 [&_input]:flex-1">
            <Action
              working={doing === "check"}
              disabled={locked}
              onClick={() => void track("check")("正在检查文件系统…", async () => {
                const result = await request<{ ok: boolean; output: string }>("/api/disks/check", { name: disk.name });
                setCheck(result);
                if (!result.ok) throw new Error("文件系统有错误，可在被控电脑上修复，或从快照恢复");
              }, "文件系统检查通过")}
            >
              {doing === "check" ? "正在检查…" : "开始检查"}
            </Action>
          </span>
          {check && <pre className={`max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs ${check.ok ? "" : " text-destructive"}`}>{check.output || (check.ok ? "无错误" : "")}</pre>}
        </div>

        <div className="flex min-w-0 flex-col gap-3 rounded-md border p-4 [&_h4]:font-medium">
          <h4>备份</h4>
          <p className="text-muted-foreground">下载完整镜像，可在电脑上直接挂载或写入真实 U 盘。</p>
          <span className="flex w-full min-w-0 flex-wrap items-center gap-2 [&_input]:min-w-24 [&_input]:flex-1">
            <a
              className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 text-xs${disk.attached && !disk.readOnly ? " pointer-events-none opacity-50" : ""}`}
              aria-disabled={disk.attached && !disk.readOnly}
              href={diskImageURL(disk.name)}
              download={disk.name}
            >
              下载镜像 · {bytes(disk.size)}
            </a>
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3 [&_h4]:font-medium">
          <h4>快照</h4>
          <span className="text-muted-foreground">保存在板子上，每个数据盘最多 3 个，占用与数据盘相同的空间。</span>
          <Action
            working={doing === "snapshot"}
            disabled={locked || disk.snapshots.length >= 3}
            onClick={() => void act("snapshot", "正在创建快照…", () => request("/api/disks/snapshot", { disk: disk.name }), "快照已创建")}
          >
            创建快照
          </Action>
        </div>
        {disk.snapshots.length === 0 ? <p className="text-sm text-muted-foreground">尚无快照。格式化前可自动创建一个。</p> : (
          <ul className="flex flex-col divide-y [&>li]:flex [&>li]:flex-wrap [&>li]:items-center [&>li]:gap-3 [&>li]:py-3">
            {disk.snapshots.map((snapshot) => {
              const restoring = typeof open === "object" && open.restore === snapshot.id;
              return (
                <li key={snapshot.id} className="">
                  <span className="tabular-nums">{when(snapshot.time)}</span>
                  <span className="text-muted-foreground tabular-nums">{bytes(snapshot.size)}</span>
                  <Button variant="outline"
                    className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 text-xs${restoring ? " bg-accent" : ""}`}
                    aria-label={`恢复 ${when(snapshot.time)} 的快照`}
                    aria-expanded={restoring}
                    disabled={locked}
                    onClick={() => setOpen(restoring ? undefined : { restore: snapshot.id })}
                  >
                    恢复…
                  </Button>
                  <ArmedButton
                    label="删除"
                    armedLabel="确认删除快照"
                    ariaLabel={`删除 ${when(snapshot.time)} 的快照`}
                    disabled={busy}
                    working={doing === `snapshot-delete:${snapshot.id}`}
                    onConfirm={() => void act(`snapshot-delete:${snapshot.id}`, "正在删除快照…", () => request("/api/disks/snapshot/delete", { disk: disk.name, id: snapshot.id }), "快照已删除")}
                  />
                  {restoring && (
                    <Confirmed onCancel={() => setOpen(undefined)} name={disk.name} busy={locked} working={doing === "restore"} action="恢复快照" onConfirm={() =>
                      void act("restore", "正在恢复快照…", () => request("/api/disks/restore", { disk: disk.name, id: snapshot.id, confirm: disk.name }), `已恢复到 ${when(snapshot.time)} 的快照`)}>
                      <p>数据盘当前内容将被 {when(snapshot.time)} 的快照替换，容量恢复为 {bytes(snapshot.size)}，之后的修改会丢失。</p>
                    </Confirmed>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ul className="flex flex-col divide-y [&>li]:flex [&>li]:flex-wrap [&>li]:items-center [&>li]:justify-between [&>li]:gap-4 [&>li]:py-4">
        {dangers.map((item) => (
          <li key={item.id}>
            <span className="flex min-w-0 flex-col gap-1 [&_h4]:font-medium">
              <h4>{item.title}</h4>
              <span className="text-muted-foreground">{item.text}</span>
            </span>
            <Button variant="outline"
              className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 text-xs${item.danger ? " border-destructive/30 text-destructive hover:bg-destructive/10" : ""}${open === item.id ? " bg-accent" : ""}`}
              aria-expanded={open === item.id}
              disabled={item.disabled}
              onClick={() => toggle(item.id)}
            >
              {item.button}
            </Button>
            {open === "resize" && item.id === "resize" && (
              <form
                className="flex w-full flex-col gap-4 rounded-md border p-4 "
                onSubmit={(event) => {
                  event.preventDefault();
                  // The server still requires the name; resize is non-destructive and snapshots first.
                  void act("resize", "正在扩容数据盘…", () => request("/api/disks/resize", { name: disk.name, sizeMiB, confirm: disk.name }), `${disk.name} 已扩容`);
                }}
              >
                <fieldset className="flex min-w-0 flex-col gap-2 text-sm flex flex-wrap gap-2 [&_legend]:mb-2">
                  <legend>新容量（当前 {bytes(disk.size)}）</legend>
                  {sizes.map((size) => (
                    <label key={size} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 has-checked:border-primary has-checked:bg-primary/5${size === sizeMiB ? " border-primary bg-primary/5" : ""}`}>
                      <input className="accent-primary" type="radio" name="disk-grow" autoFocus={size === sizeMiB} checked={size === sizeMiB} disabled={locked} onChange={() => setSizeMiB(size)} />
                      {bytes(size * 2 ** 20)}
                    </label>
                  ))}
                </fieldset>
                <p className="text-sm text-muted-foreground">板子需要容纳旧盘快照和新盘的可用空间，最多扩到 32 GiB。</p>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button variant="outline" type="button" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50" disabled={busy} onClick={() => setOpen(undefined)}>取消</Button>
                  <Action type="submit" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 border-primary bg-primary text-primary-foreground hover:bg-primary/90" working={doing === "resize"} disabled={locked || !sizeMiB}>扩容到 {bytes(sizeMiB * 2 ** 20)}</Action>
                </div>
              </form>
            )}
            {open === "format" && item.id === "format" && (
              <Confirmed onCancel={() => setOpen(undefined)} name={disk.name} busy={locked} working={doing === "format"} action="格式化" onConfirm={() =>
                void act("format", "正在格式化…", () => request("/api/disks/format", { name: disk.name, label: formatLabel, confirm: disk.name, snapshot: snapshotFirst }), `${disk.name} 已格式化`)}>
                <p>清空 {disk.name} 中的全部文件，保留容量，卷标设为「{formatLabel}」。</p>
                <label className="flex items-start gap-2 text-sm [&_input]:mt-1">
                  <input className="accent-primary" type="checkbox" checked={snapshotFirst} disabled={locked} onChange={(event) => setSnapshotFirst(event.target.checked)} />
                  格式化前创建快照{disk.snapshots.length >= 3 ? "（已达 3 个上限）" : ""}
                </label>
              </Confirmed>
            )}
            {open === "delete" && item.id === "delete" && (
              <Confirmed onCancel={() => setOpen(undefined)} name={disk.name} busy={locked} working={doing === "delete"} action="删除数据盘" onConfirm={() =>
                void act("delete", "正在删除数据盘…", () => request("/api/disks/delete", { name: disk.name, confirm: disk.name, keepSnapshots }), `${disk.name} 已删除`).then((ok) => { if (ok) onDeleted(); })}>
                <p>删除镜像文件 {disk.name}，释放 {bytes(disk.size)}。此操作无法撤销。</p>
                {disk.snapshots.length > 0 && (
                  <label className="flex items-start gap-2 text-sm [&_input]:mt-1">
                    <input className="accent-primary" type="checkbox" checked={keepSnapshots} disabled={locked} onChange={(event) => setKeepSnapshots(event.target.checked)} />
                    保留 {disk.snapshots.length} 个快照
                  </label>
                )}
              </Confirmed>
            )}
          </li>
        ))}
      </ul>
    </div></SettingsCard>
  );
}

export function DiskPanel() {
  const busy = useActionStore((s) => !!s.busy);
  const run = useActionStore((s) => s.run);
  const status = useStatusStore((s) => s.status);
  const stale = useStatusStore((s) => s.stale);
  const mediaToken = stale ? undefined : `${status?.media?.token ?? ""}:${status?.media?.readOnly}`;
  const [disks, setDisks] = useState<Disk[]>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    getDisks(controller.signal).then((list) => {
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
  }, [reload, mediaToken]);
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
      <SettingsCard className="flex min-w-0 flex-col gap-4" aria-label="数据盘列表">
        <div className="flex flex-wrap items-center justify-between gap-2 [&_h3]:text-sm [&_h3]:font-semibold">
          <h3>数据盘</h3>
          <p>板子上的 FAT32 磁盘镜像。未挂载时可在这里管理文件；在「虚拟介质」页挂载后，被控电脑和四个 KVM 界面都能使用。</p>
          {disks && <span className="ml-auto"><CreateDisk disks={disks} busy={busy} run={run} onCreated={(name) => { setSelected(name); refresh(); }} /></span>}
        </div>
        {error ? <div><InlineError>{error}</InlineError><Button variant="outline" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 text-xs" onClick={refresh}>重新读取数据盘</Button></div>
          : !disks ? <PanelSkeleton />
          : disks.length === 0 ? (
            <EmptyState icon={HardDrive}>还没有数据盘。新建一个，用来在被控电脑和这里之间传递文件。</EmptyState>
          ) : (
            <div className="grid gap-3 @lg:grid-cols-2" role="radiogroup" aria-label="选择数据盘">
              {disks.map((item) => (
                <label key={item.name} className={`flex min-w-0 cursor-pointer flex-col gap-3 rounded-md border p-4 has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-3 has-focus-visible:ring-ring/50${item.name === selected ? " border-primary bg-primary/5" : ""}`}>
                  <input className="accent-primary" type="radio" name="disk" checked={item.name === selected} onChange={() => setSelected(item.name)} />
                  <span className="flex flex-wrap items-center gap-2 [&>input]:mr-1 [&>strong]:break-all">
                    <DiskIcon />
                    <strong>{item.name}</strong>
                    {item.label && <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground">{item.label}</span>}
                  </span>
                  <Usage disk={item} />
                  <DiskState disk={item} />
                </label>
              ))}
            </div>
          )}
      </SettingsCard>
      {disk && (
        <>
          <Files key={disk.name} disk={disk} busy={busy} run={run} report={report} onChanged={refresh} />
          <Maintenance disk={disk} busy={busy} run={run} onChanged={refresh} onDeleted={() => { setSelected(undefined); refresh(); }} />
        </>
      )}
    </>
  );
}

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

function DiskIcon() {
  return (
    <svg className="media-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M4 14h16M16.5 16.5h.01" />
    </svg>
  );
}

function FileIcon({ dir }: { dir: boolean }) {
  return (
    <svg className="media-icon disk-file-icon" viewBox="0 0 24 24" aria-hidden="true">
      {dir ? <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
        : <path d="M7 3.5h7l4 4v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1zM14 3.5v4h4" />}
    </svg>
  );
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

function Action({ working, className = "button small", children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { working?: boolean }) {
  return (
    <button className={className} aria-busy={working || undefined} {...props}>
      {working && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
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
      className={`button small disk-armed${armed ? " danger is-armed" : ""}`}
      aria-label={armed ? undefined : ariaLabel}
      disabled={disabled}
      working={working}
      onBlur={() => setArmed(false)}
      onClick={() => (armed ? onConfirm() : setArmed(true))}
    >
      <span className="disk-swap">
        <span aria-hidden={armed}>{label}</span>
        <span aria-hidden={!armed}>{armedLabel}</span>
      </span>
    </Action>
  );
}

function DiskState({ disk }: { disk: Disk }) {
  if (disk.attached) {
    return (
      <span className="status status-accent">
        <span className="lamp" aria-hidden="true" />
        {disk.readOnly ? "已挂载（只读）" : "已挂载到被控电脑"}
      </span>
    );
  }
  if (disk.editing) {
    return (
      <span className="status status-warning">
        <span className="lamp" aria-hidden="true" />
        正在编辑
      </span>
    );
  }
  return (
    <span className="status status-good">
      <span className="lamp" aria-hidden="true" />
      空闲
    </span>
  );
}

function Usage({ disk }: { disk: Disk }) {
  if (disk.freeBytes == null) return <span className="muted">无法读取文件系统</span>;
  const used = Math.max(0, disk.size - disk.freeBytes);
  const percent = Math.min(100, (used / disk.size) * 100);
  return (
    <span className={`disk-usage${disk.freeBytes < disk.size * 0.1 ? " is-low" : ""}`}>
      <span className="disk-usage-bar" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </span>
      <span className="num">剩余 {bytes(disk.freeBytes)} / {bytes(disk.size)}</span>
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
      <button className="button small" disabled={busy || disks.length >= 8} onClick={() => setOpen(true)}>
        新建数据盘
      </button>
    );
  }
  return (
    <form
      className="disk-create reveal"
      onKeyDown={(event) => { if (event.key === "Escape" && !busy) setOpen(false); }}
      onSubmit={(event) => {
        event.preventDefault();
        if (invalid) return;
        void track("create")(`正在创建 ${file}…`, () => request("/api/disks", { name: file, sizeMiB, label: label.trim() }), `数据盘 ${file} 已创建`)
          .then((ok) => { if (ok) { setOpen(false); setName(""); onCreated(file); } });
      }}
    >
      <label className="field">
        <span>名称</span>
        <span className="disk-name-input">
          <input autoFocus value={name} disabled={busy} maxLength={60} placeholder="tools" onChange={(event) => setName(event.target.value)} />
          <span className="muted">.img</span>
        </span>
      </label>
      <label className="field">
        <span>卷标</span>
        <input value={label} disabled={busy} onChange={(event) => setLabel(normalizeLabel(event.target.value))} />
      </label>
      <fieldset className="field disk-sizes">
        <legend>容量</legend>
        {SIZES.map((size) => (
          <label key={size} className={`disk-size${size === sizeMiB ? " is-checked" : ""}`}>
            <input type="radio" name="disk-size" checked={size === sizeMiB} disabled={busy} onChange={() => setSizeMiB(size)} />
            {bytes(size * 2 ** 20)}
          </label>
        ))}
      </fieldset>
      <p className="hint">FAT32 文件系统，Windows、macOS 与 Linux 均可直接读写；单个文件不能超过 4 GiB。空间立即在板子上分配。</p>
      <div className="media-actions">
        {invalid && name && <span className="edid-error">{invalid}</span>}
        <button type="button" className="button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
        <Action type="submit" className="button primary" working={doing === "create"} disabled={busy || !!invalid}>创建</Action>
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
    <div className={`disk-uploads reveal${finished ? " is-done" : ""}`} role="status">
      <div className="disk-uploads-head">
        {finished ? <span className="disk-done" aria-hidden="true">✓</span> : <span className="spinner" aria-hidden="true" />}
        <strong>
          {finished ? `已上传 ${uploads.length} 个文件` : writing ? `正在写入 ${current.file.name}…` : `正在上传 ${current.file.name}`}
        </strong>
        {!finished && uploads.length > 1 && <span className="num muted">第 {index + 1}/{uploads.length} 个</span>}
        <span className="num muted">{bytes(sent)} / {bytes(total)}</span>
        {!finished && <button className="button small" onClick={onCancel}>取消</button>}
      </div>
      <span className="disk-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={sent}>
        <span style={{ width: `${total ? (sent / total) * 100 : 100}%` }} />
      </span>
      {!finished && (
        <p className="hint num">
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
    <section
      className={`section disk-files${dragging ? " is-dragging" : ""}${blocked ? " is-blocked" : ""}`}
      aria-label="文件"
      data-drop={blocked ?? "松开以上传到当前文件夹"}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = blocked ? "none" : "copy";
        setDragging(true);
      }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
      onDrop={onDrop}
    >
      <div className="section-head">
        <h3>文件</h3>
        <nav className="disk-crumbs" aria-label="路径">
          <button className="disk-crumb" disabled={path === "/"} onClick={() => setPath("/")}>{disk.label || disk.name}</button>
          {crumbs.map((part, index) => (
            <span key={index}>
              <span className="muted" aria-hidden="true"> / </span>
              <button className="disk-crumb" disabled={index === crumbs.length - 1} onClick={() => setPath("/" + crumbs.slice(0, index + 1).join("/"))}>{part}</button>
            </span>
          ))}
        </nav>
        <span className="disk-toolbar">
          <Action working={loading && !!listing} disabled={busy || !entries} onClick={() => setReload((value) => value + 1)}>刷新</Action>
          <button className="button small" disabled={locked || !entries} onClick={() => { setFolder(""); }}>新建文件夹</button>
          <button className="button small primary" disabled={locked || !entries} onClick={() => input.current?.click()}>上传文件</button>
          <input ref={input} type="file" multiple hidden onChange={(event) => { chooseFiles(event.target.files); event.target.value = ""; }} />
        </span>
      </div>

      {disk.attached && (
        <p className="disk-note reveal" role="note">
          数据盘正挂载在被控电脑上，此处只能浏览和下载；被控电脑尚未写回的内容不会显示。需要修改时先在被控电脑安全弹出，再到「虚拟介质」页弹出。
        </p>
      )}
      {listing?.stale && !disk.attached && <p className="disk-note" role="note">列表读取时数据盘仍在使用，内容可能不是最新。</p>}

      <Uploads uploads={uploads} started={started} onCancel={() => abort.current?.abort()} />

      {pending && (
        <div className="confirm disk-confirm reveal">
          <span>当前文件夹已有 {conflicts.map((file) => `「${file.name}」`).join("、")}，是否覆盖？</span>
          <button className="button small" onClick={() => setPending(undefined)}>取消</button>
          <button className="button small danger" onClick={() => void startUpload(pending, true)}>覆盖</button>
        </div>
      )}

      {folder !== undefined && (
        <form
          className="disk-inline reveal"
          onKeyDown={(event) => { if (event.key === "Escape" && !busy) setFolder(undefined); }}
          onSubmit={(event) => {
            event.preventDefault();
            if (!validName(folder)) return;
            void mutate("mkdir", `正在新建文件夹…`, () => request("/api/disks/mkdir", { disk: disk.name, path: join(path, folder) }), `已新建文件夹 ${folder}`)
              .then((ok) => { if (ok) setFolder(undefined); });
          }}
        >
          <FileIcon dir />
          <input autoFocus aria-label="文件夹名称" value={folder} disabled={busy} onChange={(event) => setFolder(event.target.value)} />
          <button type="button" className="button small" onClick={() => setFolder(undefined)}>取消</button>
          <Action type="submit" className="button small primary" working={doing === "mkdir"} disabled={busy || !validName(folder)}>新建</Action>
        </form>
      )}

      {error ? <p className="edid-error" role="alert">{error}</p>
        : !listing ? <div className="skeleton media-skeleton" />
        : (
          <div className={`disk-table${loading ? " is-loading" : ""}`} role="table" aria-label="文件列表" aria-busy={loading}>
            {shown !== "/" && (
              <div className="disk-row" role="row">
                <button className="disk-entry" onClick={() => setPath(parent(shown))}>
                  <FileIcon dir />
                  <span className="disk-entry-name">..</span>
                </button>
              </div>
            )}
            {listing.entries.length === 0 && (
              <div className="media-empty disk-drop">
                <FileIcon dir={false} />
                <p>{readOnly ? "文件夹为空。" : "文件夹为空。把文件拖到这里，或点「上传文件」。"}</p>
              </div>
            )}
            {listing.entries.map((entry: DiskEntry) => {
              const target = join(shown, entry.name);
              const open = selected === entry.name;
              return (
                <div key={entry.name} role="row" className={`disk-row${open ? " is-selected" : ""}`}>
                  {renaming === entry.name ? (
                    <form
                      className="disk-inline reveal"
                      onKeyDown={(event) => { if (event.key === "Escape" && !busy) setRenaming(undefined); }}
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!validName(newName) || newName === entry.name) return;
                        void mutate(`mv:${entry.name}`, "正在重命名…", () => request("/api/disks/mv", { disk: disk.name, from: target, to: join(shown, newName) }), `已重命名为 ${newName}`);
                      }}
                    >
                      <FileIcon dir={entry.dir} />
                      <input autoFocus aria-label="新名称" value={newName} disabled={busy} onChange={(event) => setNewName(event.target.value)} />
                      <button type="button" className="button small" onClick={() => setRenaming(undefined)}>取消</button>
                      <Action type="submit" className="button small primary" working={doing === `mv:${entry.name}`} disabled={busy || !validName(newName) || newName === entry.name}>重命名</Action>
                    </form>
                  ) : (
                    <>
                      <button
                        className="disk-entry"
                        aria-expanded={entry.dir ? undefined : open}
                        onClick={() => (entry.dir ? setPath(target) : setSelected(open ? undefined : entry.name))}
                      >
                        <FileIcon dir={entry.dir} />
                        <span className="disk-entry-name">{entry.name}</span>
                        <span className="disk-entry-meta num">{entry.dir ? "" : bytes(entry.size)}</span>
                        <span className="disk-entry-meta num disk-entry-time">{entry.mtime ? when(entry.mtime) : ""}</span>
                      </button>
                      <span className="disk-row-actions">
                        {!entry.dir && <a className="button small" href={diskFileURL(disk.name, target)} download={entry.name} aria-label={`下载 ${entry.name}`}>下载</a>}
                        {!readOnly && (
                          <>
                            <button className="button small" aria-label={`重命名 ${entry.name}`} disabled={locked} onClick={() => { setRenaming(entry.name); setNewName(entry.name); }}>重命名</button>
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
                        <p className="disk-detail reveal num">
                          <span>{bytes(entry.size)}{entry.size >= 1024 ? `（${entry.size.toLocaleString("zh-CN")} 字节）` : ""}</span>
                          {entry.mtime ? <span>修改于 {when(entry.mtime)}</span> : null}
                          <span className="disk-detail-path">{target}</span>
                        </p>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
    </section>
  );
}

function Confirmed({ name, onConfirm, children, action, busy, working }: {
  name: string; onConfirm: () => void; children: ReactNode; action: string; busy: boolean; working: boolean;
}) {
  const [typed, setTyped] = useState("");
  return (
    <form
      className="disk-danger reveal"
      onSubmit={(event) => { event.preventDefault(); if (!busy && typed === name) onConfirm(); }}
    >
      {children}
      <label className="field">
        <span>输入 <code>{name}</code> 确认</span>
        <input autoFocus value={typed} disabled={busy} autoComplete="off" onChange={(event) => setTyped(event.target.value)} />
      </label>
      <div className="media-actions">
        <Action type="submit" className="button danger" working={working} disabled={busy || typed !== name}>{action}</Action>
      </div>
    </form>
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
    <section
      className="section disk-maintenance"
      aria-label="维护"
      onKeyDown={(event) => { if (event.key === "Escape" && open && !busy) setOpen(undefined); }}
    >
      <div className="section-head">
        <h3>维护</h3>
        <p>{disk.attached ? "数据盘挂载期间不能维护，先在被控电脑安全弹出，再到「虚拟介质」页弹出。" : "以下操作需要数据盘未挂载到被控电脑。"}</p>
      </div>

      <div className="disk-grid">
        <form
          className="disk-cell"
          onSubmit={(event) => {
            event.preventDefault();
            void act("label", "正在修改卷标…", () => request("/api/disks/label", { name: disk.name, label: label.trim() }), `卷标已改为 ${label.trim()}`);
          }}
        >
          <h4>卷标</h4>
          <p className="muted">被控电脑上显示的名称，最多 11 位大写字母或数字。</p>
          <span className="disk-inline">
            <input aria-label="卷标" value={label} disabled={locked} onChange={(event) => setLabel(normalizeLabel(event.target.value))} />
            <Action type="submit" working={doing === "label"} disabled={locked || !label.trim() || label.trim() === disk.label}>保存</Action>
          </span>
        </form>

        <div className="disk-cell">
          <h4>检查文件系统</h4>
          <p className="muted">只读检查，不修复。被控电脑异常拔出后建议检查。</p>
          <span className="disk-inline">
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
          {check && <pre className={`disk-check reveal${check.ok ? "" : " is-bad"}`}>{check.output || (check.ok ? "无错误" : "")}</pre>}
        </div>

        <div className="disk-cell">
          <h4>备份</h4>
          <p className="muted">下载完整镜像，可在电脑上直接挂载或写入真实 U 盘。</p>
          <span className="disk-inline">
            <a
              className={`button small${disk.attached && !disk.readOnly ? " is-disabled" : ""}`}
              aria-disabled={disk.attached && !disk.readOnly}
              href={diskImageURL(disk.name)}
              download={disk.name}
            >
              下载镜像 · {bytes(disk.size)}
            </a>
          </span>
        </div>
      </div>

      <div className="disk-snapshots">
        <div className="disk-snapshots-head">
          <h4>快照</h4>
          <span className="muted">保存在板子上，每个数据盘最多 3 个，占用与数据盘相同的空间。</span>
          <Action
            working={doing === "snapshot"}
            disabled={locked || disk.snapshots.length >= 3}
            onClick={() => void act("snapshot", "正在创建快照…", () => request("/api/disks/snapshot", { disk: disk.name }), "快照已创建")}
          >
            创建快照
          </Action>
        </div>
        {disk.snapshots.length === 0 ? <p className="hint">尚无快照。格式化前可自动创建一个。</p> : (
          <ul className="disk-snapshot-list">
            {disk.snapshots.map((snapshot) => {
              const restoring = typeof open === "object" && open.restore === snapshot.id;
              return (
                <li key={snapshot.id} className="reveal">
                  <span className="num">{when(snapshot.time)}</span>
                  <span className="muted num">{bytes(snapshot.size)}</span>
                  <button
                    className={`button small${restoring ? " is-open" : ""}`}
                    aria-label={`恢复 ${when(snapshot.time)} 的快照`}
                    aria-expanded={restoring}
                    disabled={locked}
                    onClick={() => setOpen(restoring ? undefined : { restore: snapshot.id })}
                  >
                    恢复…
                  </button>
                  <ArmedButton
                    label="删除"
                    armedLabel="确认删除快照"
                    ariaLabel={`删除 ${when(snapshot.time)} 的快照`}
                    disabled={busy}
                    working={doing === `snapshot-delete:${snapshot.id}`}
                    onConfirm={() => void act(`snapshot-delete:${snapshot.id}`, "正在删除快照…", () => request("/api/disks/snapshot/delete", { disk: disk.name, id: snapshot.id }), "快照已删除")}
                  />
                  {restoring && (
                    <Confirmed name={disk.name} busy={locked} working={doing === "restore"} action="恢复快照" onConfirm={() =>
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

      <ul className="disk-dangers">
        {dangers.map((item) => (
          <li key={item.id}>
            <span className="disk-danger-text">
              <h4>{item.title}</h4>
              <span className="muted">{item.text}</span>
            </span>
            <button
              className={`button small${item.danger ? " danger" : ""}${open === item.id ? " is-open" : ""}`}
              aria-expanded={open === item.id}
              disabled={item.disabled}
              onClick={() => toggle(item.id)}
            >
              {item.button}
            </button>
            {open === "resize" && item.id === "resize" && (
              <form
                className="disk-grow reveal"
                onSubmit={(event) => {
                  event.preventDefault();
                  // The server still requires the name; resize is non-destructive and snapshots first.
                  void act("resize", "正在扩容数据盘…", () => request("/api/disks/resize", { name: disk.name, sizeMiB, confirm: disk.name }), `${disk.name} 已扩容`);
                }}
              >
                <fieldset className="field disk-sizes">
                  <legend>新容量（当前 {bytes(disk.size)}）</legend>
                  {sizes.map((size) => (
                    <label key={size} className={`disk-size${size === sizeMiB ? " is-checked" : ""}`}>
                      <input type="radio" name="disk-grow" autoFocus={size === sizeMiB} checked={size === sizeMiB} disabled={locked} onChange={() => setSizeMiB(size)} />
                      {bytes(size * 2 ** 20)}
                    </label>
                  ))}
                </fieldset>
                <p className="hint">板子需要容纳旧盘快照和新盘的可用空间，最多扩到 32 GiB。</p>
                <div className="media-actions">
                  <button type="button" className="button" disabled={busy} onClick={() => setOpen(undefined)}>取消</button>
                  <Action type="submit" className="button primary" working={doing === "resize"} disabled={locked || !sizeMiB}>扩容到 {bytes(sizeMiB * 2 ** 20)}</Action>
                </div>
              </form>
            )}
            {open === "format" && item.id === "format" && (
              <Confirmed name={disk.name} busy={locked} working={doing === "format"} action="格式化" onConfirm={() =>
                void act("format", "正在格式化…", () => request("/api/disks/format", { name: disk.name, label: formatLabel, confirm: disk.name, snapshot: snapshotFirst }), `${disk.name} 已格式化`)}>
                <p>清空 {disk.name} 中的全部文件，保留容量，卷标设为「{formatLabel}」。</p>
                <label className="media-check">
                  <input type="checkbox" checked={snapshotFirst} disabled={locked} onChange={(event) => setSnapshotFirst(event.target.checked)} />
                  格式化前创建快照{disk.snapshots.length >= 3 ? "（已达 3 个上限）" : ""}
                </label>
              </Confirmed>
            )}
            {open === "delete" && item.id === "delete" && (
              <Confirmed name={disk.name} busy={locked} working={doing === "delete"} action="删除数据盘" onConfirm={() =>
                void act("delete", "正在删除数据盘…", () => request("/api/disks/delete", { name: disk.name, confirm: disk.name, keepSnapshots }), `${disk.name} 已删除`).then((ok) => { if (ok) onDeleted(); })}>
                <p>删除镜像文件 {disk.name}，释放 {bytes(disk.size)}。此操作无法撤销。</p>
                {disk.snapshots.length > 0 && (
                  <label className="media-check">
                    <input type="checkbox" checked={keepSnapshots} disabled={locked} onChange={(event) => setKeepSnapshots(event.target.checked)} />
                    保留 {disk.snapshots.length} 个快照
                  </label>
                )}
              </Confirmed>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DiskPanel({ busy, run, report, mediaToken }: { busy: boolean; run: Run; report: Report; mediaToken?: string }) {
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
      <section className="section" aria-label="数据盘列表">
        <div className="section-head">
          <h3>数据盘</h3>
          <p>板子上的 FAT32 磁盘镜像。未挂载时可在这里管理文件；在「虚拟介质」页挂载后，被控电脑和四个 KVM 界面都能使用。</p>
          {disks && <span className="media-refresh"><CreateDisk disks={disks} busy={busy} run={run} onCreated={(name) => { setSelected(name); refresh(); }} /></span>}
        </div>
        {error ? <div role="alert"><p className="edid-error">{error}</p><button className="button small" onClick={refresh}>重新读取数据盘</button></div>
          : !disks ? <div className="skeleton media-skeleton" />
          : disks.length === 0 ? (
            <div className="media-empty">
              <DiskIcon />
              <p>还没有数据盘。新建一个，用来在被控电脑和这里之间传递文件。</p>
            </div>
          ) : (
            <div className="disk-cards" role="radiogroup" aria-label="选择数据盘">
              {disks.map((item) => (
                <label key={item.name} className={`disk-card${item.name === selected ? " is-checked" : ""}`}>
                  <input type="radio" name="disk" checked={item.name === selected} onChange={() => setSelected(item.name)} />
                  <span className="disk-card-head">
                    <DiskIcon />
                    <strong>{item.name}</strong>
                    {item.label && <span className="tag tag-quiet">{item.label}</span>}
                  </span>
                  <Usage disk={item} />
                  <DiskState disk={item} />
                </label>
              ))}
            </div>
          )}
      </section>
      {disk && (
        <>
          <Files key={disk.name} disk={disk} busy={busy} run={run} report={report} onChanged={refresh} />
          <Maintenance disk={disk} busy={busy} run={run} onChanged={refresh} onDeleted={() => { setSelected(undefined); refresh(); }} />
        </>
      )}
    </>
  );
}

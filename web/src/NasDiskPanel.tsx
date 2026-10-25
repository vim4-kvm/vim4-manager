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

type Setup = { storage: string; path: string; mode: "ro" | "rw"; label: string; labelEdited: boolean };
type Confirm = { kind: "discard"; id: string; name: string } | { kind: "cancel" } | { kind: "trash"; id: string; files: number; bytes: number };

const SKIP_REASONS: Record<string, string> = {
  "file size outside FAT32 range": "不小于 4 GiB",
  "invalid FAT name or more than 255 UTF-16 units": "名称 U 盘不支持",
  "case-insensitive duplicate": "与同目录项重名（不区分大小写）",
  "symbolic link or special file": "链接或特殊文件",
  "path depth limit": "目录层级过深",
  "directory entry limit": "所在文件夹条目过多",
  "excluded directory": "管理用目录",
};

const CONFIRM_TITLE = { discard: "放弃修改", cancel: "取消挂载", trash: "清空回收目录" };
const HIDDEN_RESULT_KEY = "nasdisk-hidden-last";

export function folderLabel(path: string) {
  const name = path.split("/").filter(Boolean).pop() ?? "";
  // A partly transliterated name ("U盘测试" -> "U") reads worse than the generic default.
  if (/[^\x20-\x7e]/.test(name)) return "NAS";
  const label = name.toUpperCase().replace(/[^A-Z0-9 _-]/g, "").trim().slice(0, 11).trim();
  return label || "NAS";
}

function displayPath(path: string) {
  return path === "/" ? "根目录" : path.replace(/^\//, "");
}

function counts(c: NasDiskCounts) {
  return [
    c.writes && `写入 ${c.writes} 个文件`,
    c.mkdirs && `新建 ${c.mkdirs} 个文件夹`,
    c.renames && `改名或移动 ${c.renames} 项`,
    c.deletes && `删除 ${c.deletes} 项（移入回收目录）`,
    c.conflicts && `${c.conflicts} 个冲突副本`,
  ]
    .filter(Boolean)
    .join("，");
}

function when(seconds: number) {
  return new Date(seconds * 1000).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function useNasDisk() {
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
  }, [pending, active]);

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
    <SettingsCard label="U 盘活动"><div role="group" aria-label="U 盘" className="flex min-w-0 flex-col gap-4">
      {pending && (
        <span className="text-muted-foreground" role="status">
          <Spinner />
          {pending}
        </span>
      )}
      {state && !state.known && <p className="text-sm text-warning-foreground">暂时无法读取 U 盘状态。</p>}

      {session ? (
        <SessionCard
          key={session.id}
          session={session}
          locked={locked}
          showSkipped={showSkipped}
          setShowSkipped={setShowSkipped}
          onCancel={() => setConfirming({ kind: "cancel" })}
          onReattach={() => void act("正在重新挂载…", () => nasDiskWrite("/reattach", { id: session.id }))}
          onForce={() => void act("正在回写…", () => nasDiskWrite("/commit", { id: session.id, force: true }))}
          onRetry={() => void act("正在回写…", () => nasDiskWrite("/commit", { id: session.id }))}
          onDiscard={() =>
            session.mode === "ro"
              ? void act("正在结束…", () => nasDiskWrite("/discard", { id: session.id, confirm: session.id }))
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
          <h4>未写回的修改</h4>
          <p className="text-muted-foreground">板子重启或服务中断时，这些 U 盘修改还没有写回 NAS。</p>
          <ul>
            {state.pending.map((p) => (
              <li key={p.id}>
                <div>
                  <strong>
                    {p.storageName} › {displayPath(p.path)}
                  </strong>
                  <span className="text-muted-foreground">
                    {when(p.startedAt)} 挂载 · 已写入 {bytes(p.writtenBytes)}
                    {p.journal && " · 回写进行到一半"}
                  </span>
                </div>
                <Button variant="outline" disabled={locked || active} onClick={() => void act("正在回写…", () => nasDiskWrite("/commit", { id: p.id }))}>
                  写回 NAS
                </Button>
                <Button variant="outline"
                  disabled={locked || active}
                  onClick={() => setConfirming({ kind: "discard", id: p.id, name: `${p.storageName} › ${displayPath(p.path)}` })}
                >
                  放弃…
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {confirming && (
        <ConfirmDialog open onOpenChange={(open) => { if (!open) setConfirming(undefined); }}
          title={CONFIRM_TITLE[confirming.kind]} confirm={CONFIRM_TITLE[confirming.kind]} cancel="返回" destructive disabled={locked}
          description={confirming.kind === "discard"
            ? `放弃「${confirming.name}」中被控电脑做的全部修改。NAS 上的文件保持挂载前的样子，此操作无法撤销。`
            : confirming.kind === "trash"
              ? `永久删除回收目录中的 ${confirming.files.toLocaleString()} 个文件（${bytes(confirming.bytes)}）。它们是回写时被删除或覆盖的旧版本，删除后无法找回。`
              : "停止准备 U 盘。被控电脑还没有看到这个 U 盘。"}
          onConfirm={() => void (confirming.kind === "discard"
            ? act("正在放弃修改…", () => nasDiskWrite("/discard", { id: confirming.id, confirm: confirming.id }))
            : confirming.kind === "trash"
              ? act("正在清空回收目录…", () => nasDiskWrite("/trash-empty", { id: confirming.id, confirm: confirming.id }))
              : act("正在取消…", () => nasDiskWrite("/cancel", {})))} />
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
      ? "不能使用这个名称"
      : /[\x00-\x1f\x7f\\/"*?<>|:%]/.test(nameTrimmed)
      ? "名称不能包含 \\ / \" * ? < > | : % 或控制字符"
      : new TextEncoder().encode(nameTrimmed).length > 255
        ? "名称过长"
        : dirs?.names.some((n) => n.toLowerCase() === nameTrimmed.toLowerCase())
          ? "已有同名文件夹"
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
    <form aria-label="选择要作为 U 盘的文件夹"
      className="flex min-w-0 flex-col gap-4 rounded-md border bg-muted/40 p-4 "
      onSubmit={(e) => {
        e.preventDefault();
        if (canStart) onStart({ ...setup, mode: readOnlyOnly ? "ro" : setup.mode });
      }}
    >
      <h4>选择要作为 U 盘的文件夹</h4>

      <div className="flex min-w-0 flex-col gap-3 rounded-md border bg-card p-3">
        <nav className="flex flex-wrap items-center gap-1" aria-label="文件夹路径">
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
            {dirError} <Button variant="link" size="inline" type="button" onClick={() => setRetry((n) => n + 1)}>重试</Button>
          </div>
        ) : !dirs ? (
          <PanelSkeleton label="正在读取…" rows={2} />
        ) : dirs.names.length === 0 ? (
          <p className="text-muted-foreground p-3 text-center text-sm">没有子文件夹。</p>
        ) : (
          <div>
          <AnimatedList className="flex max-h-64 flex-col divide-y overflow-auto" label="子文件夹" items={dirs.names} getKey={(name) => name}>{(name) => (
                <Button variant="ghost" className="h-auto w-full px-0 py-2 text-left font-normal" type="button" onClick={() => go(`${setup.path === "/" ? "" : setup.path}/${name}`)}>
                  <FileColumns>
                  <Folder aria-hidden="true" className="size-4 shrink-0" />
                  <span>{name}</span>
                  <span className="ml-auto" aria-hidden="true">›</span>
                  </FileColumns>
                </Button>
            )}</AnimatedList>
            {dirs.truncated && <p className="p-3 text-center text-sm text-muted-foreground">只显示前 500 个文件夹</p>}
          </div>
        )}
        {dirs && !readOnlyOnly && (
          <div className="border-t pt-3">
            {newName === undefined ? (
              <Button variant="link" size="inline" type="button" disabled={locked} onClick={() => setNewName("")}>
                <span aria-hidden="true">+ </span>新建文件夹
              </Button>
            ) : (
              <>
                <div className="flex flex-wrap gap-2 [&_input]:min-w-32 [&_input]:flex-1">
                  <Input
                    aria-label="新文件夹名称"
                    placeholder="文件夹名称"
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
                    {creating ? "正在创建…" : "创建"}
                  </Button>
                  <Button variant="outline" type="button" disabled={creating} onClick={() => setNewName(undefined)}>
                    取消
                  </Button>
                </div>
                {(nameProblem || mkdirError) && <span className="text-xs text-muted-foreground text-destructive">{nameProblem || mkdirError}</span>}
              </>
            )}
          </div>
        )}
        <p className="border-t pt-3 text-sm [overflow-wrap:anywhere]">
          已选择 <strong>{storage.name} › {displayPath(setup.path)}</strong>
        </p>
      </div>

      <Segmented label="模式" className="max-sm:grid-cols-1">
        <SegmentedOption title="可写" detail={readOnlyOnly ? "NAS 不允许写入" : "安全弹出后写回 NAS"} pressed={setup.mode === "rw" && !readOnlyOnly} disabled={readOnlyOnly} onClick={() => setSetup({ ...setup, mode: "rw" })} />
        <SegmentedOption title="只读" detail="电脑只能读取" pressed={setup.mode === "ro" || readOnlyOnly} onClick={() => setSetup({ ...setup, mode: "ro" })} />
      </Segmented>

      {editingLabel ? (
        <label className="flex min-w-0 flex-col gap-2 text-sm max-w-64">
          卷标
          <Input
            value={setup.label}
            autoFocus
            maxLength={11}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!labelValid}
            onChange={(e) => setSetup({ ...setup, label: e.target.value.toUpperCase(), labelEdited: true })}
          />
          {!labelValid && <span className="text-xs text-muted-foreground">1–11 个大写字母、数字、空格、下划线或连字符</span>}
        </label>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span>卷标 <strong>{setup.label}</strong></span>
          <Button variant="link" size="inline" type="button" onClick={() => setEditingLabel(true)}>修改</Button>
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        单个文件不小于 4 GiB 或名称 U 盘不支持的文件不会出现在 U 盘里，也不会被删除。
      </p>
      {occupiedMedia && (
        <p className="text-sm text-warning-foreground" role="status">
          虚拟介质已挂载「{mediaName(occupiedMedia)}」，先在<a className="text-sm text-primary underline-offset-4 hover:underline" href="#/media">虚拟介质页</a>弹出。
        </p>
      )}
      {status && status.hardware.usb !== "configured" && (
        <p className="text-sm text-warning-foreground" role="status">被控电脑尚未通过 USB 连接，连接后即可看到 U 盘。</p>
      )}

      <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
        <Button variant="outline" type="button" onClick={onCancel}>
          取消
        </Button>
        <Button variant="default" type="submit" disabled={!canStart}>
          挂载到被控电脑
        </Button>
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
    scanning: `正在扫描文件夹… 已扫描 ${s.scanned.toLocaleString()} 项`,
    attaching: "正在连接被控电脑…",
    attached: s.hostConnected ? "已挂载到被控电脑" : "已挂载，USB 未连接",
    parsing: "已弹出，正在检查修改…",
    committing: "正在把修改写回 NAS…",
    "needs-decision": "U 盘没有被安全弹出",
    failed: "U 盘出错",
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
              U 盘 · {s.storageName} › {displayPath(s.path)}
            </strong>
            <Badge variant="secondary">{rw ? "可写" : "只读"}</Badge>
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
              {s.files.toLocaleString()} 个文件 · {s.dirs.toLocaleString()} 个文件夹 · 已用 {bytes(s.usedBytes)} / 容量 {bytes(s.volumeBytes)}
              {rw && s.writtenBytes > 0 && ` · 电脑已写入 ${bytes(s.writtenBytes)}`}
            </span>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {(s.state === "scanning" || s.state === "attaching") && (
            <Button variant="outline" disabled={locked} onClick={onCancel}>
              取消
            </Button>
          )}
        </div>
      </div>

      {s.nasStalled && (s.state === "attached" || s.state === "committing") && (
        <p className="text-sm text-warning-foreground" role="status">
          {s.state === "attached" ? "NAS 暂时无响应，电脑上读写这个 U 盘会出错；NAS 恢复后自动恢复。" : "NAS 暂时无响应，回写在等待。"}
        </p>
      )}
      {s.state === "attached" && (
        <div className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p>{rw ? "在电脑上安全弹出后，修改会写回 NAS。" : "在电脑上安全弹出后，即可结束这次 U 盘。"}</p>
          <details className="text-xs [&_summary]:cursor-pointer [&_summary]:text-primary [&_p]:mt-2 [&_code]:mt-2 [&_code]:block [&_li]:mt-2"><summary>如何安全弹出</summary><p>{hostEject}</p></details>
        </div>
      )}

      {s.state === "committing" && progress && (
        <div className="flex flex-col gap-2 text-xs">
          <span className="block h-1.5 w-full overflow-hidden rounded-full bg-primary/10 [&>span]:block [&>span]:h-full [&>span]:rounded-full [&>span]:bg-primary">
            <span style={{ width: `${Math.max(2, ratio * 100)}%` }} />
          </span>
          <span className="text-muted-foreground">
            {progress.done} / {progress.total} 步{progress.bytesTotal > 0 && ` · ${bytes(progress.bytesDone)} / ${bytes(progress.bytesTotal)}`}
            {progress.current && ` · ${progress.current}`}
          </span>
        </div>
      )}
      {s.state === "committing" && s.plan && <p className="text-muted-foreground text-sm">{counts(s.plan) || "没有需要写回的修改"}</p>}

      {s.state === "needs-decision" && s.decision && (
        <div className="flex flex-col gap-4 rounded-md border border-warning/30 bg-warning/5 p-4">
          <p>
            {s.decision.reason ||
              "被控电脑可能在写入完成前拔出了 U 盘，文件系统不完整。"}
            修改仍保存在 NAS 的暂存区，尚未写回。
          </p>
          <Detail text={s.detail} />
          <ul className="flex flex-col gap-4 [&>li]:flex [&>li]:flex-wrap [&>li]:items-center [&>li]:gap-3">
            <li>
              <Button variant="default" disabled={locked} onClick={onReattach}>
                重新挂载
              </Button>
              <span className="text-muted-foreground">让电脑检查修复 U 盘，再安全弹出（推荐）</span>
            </li>
            {s.decision.canForce && (
              <li>
                <Button variant="outline" disabled={locked} onClick={onForce}>
                  写回能识别的内容
                </Button>
                <span className="text-muted-foreground">只写入完整读出的文件，不执行删除</span>
              </li>
            )}
            <li>
              <Button variant="destructive" disabled={locked} onClick={onDiscard}>
                放弃修改…
              </Button>
              <span className="text-muted-foreground">NAS 保持挂载前的样子</span>
            </li>
          </ul>
        </div>
      )}

      {s.state === "failed" && (
        <div className="flex flex-col gap-4 rounded-md border border-warning/30 bg-warning/5 p-4">
          <p>
            {s.error || "U 盘出错。"}
            {rw && " 未写回的修改仍保存在 NAS 的暂存区。"}
          </p>
          <Detail text={s.detail} />
          <ul className="flex flex-col gap-4 [&>li]:flex [&>li]:flex-wrap [&>li]:items-center [&>li]:gap-3">
            {rw && (
              <li>
                <Button variant="default" disabled={locked} onClick={onRetry}>
                  重试写回
                </Button>
                <span className="text-muted-foreground">NAS 恢复访问后再试</span>
              </li>
            )}
            <li>
              <Button variant="destructive" disabled={locked} onClick={onDiscard}>
                {rw ? "放弃修改…" : "结束"}
              </Button>
              <span className="text-muted-foreground">{rw ? "NAS 保持挂载前的样子" : "结束这次 U 盘"}</span>
            </li>
          </ul>
        </div>
      )}

      {s.skippedCount > 0 && (
        <div className="text-xs [&_ul]:mt-2 [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-2 [&_li]:flex [&_li]:flex-wrap [&_li]:gap-2">
          <Button variant="link" size="inline" type="button" aria-expanded={showSkipped} onClick={() => setShowSkipped(!showSkipped)}>
            {s.skippedCount} 项未放入 U 盘
          </Button>
          <span className="text-muted-foreground"> · 它们留在 NAS 上，不会被删除</span>
          {showSkipped && (
            <ul>
              {s.skipped.map((item) => (
                <li key={item.path}>
                  <code className="font-mono break-all">{item.path}</code>
                  <span className="text-muted-foreground">{SKIP_REASONS[item.reason] ?? item.reason}</span>
                </li>
              ))}
              {s.skippedCount > s.skipped.length && <li className="text-muted-foreground">另有 {s.skippedCount - s.skipped.length} 项未列出</li>}
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
    <details className="text-xs [&_summary]:cursor-pointer [&_summary]:text-primary [&_p]:mt-2 [&_code]:mt-2 [&_code]:block [&_li]:mt-2">
      <summary>技术细节</summary>
      <code className="font-mono break-all">{text}</code>
    </details>
  );
}

function LastResult({ last, locked, onEmptyTrash, onHide }: { last: NasDiskLast; locked: boolean; onEmptyTrash: (t: { files: number; bytes: number }) => void; onHide: () => void }) {
  const where = `${last.storageName} › ${displayPath(last.path)}`;
  const text = {
    committed: counts(last.summary) ? `已写回 NAS：${counts(last.summary)}。` : "已写回 NAS。",
    unchanged: last.mode === "ro" ? "只读 U 盘已弹出。" : "已弹出，电脑没有修改文件。",
    discarded: "已放弃被控电脑的修改。",
    cancelled: "已取消挂载。",
    failed: `回写失败：${last.error || "未知错误"}`,
  }[last.result];
  return (
    <div role="group" aria-label="上次" className={`flex flex-col gap-3${last.result === "failed" ? " text-destructive" : ""}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]"><span className="text-muted-foreground">上次 · {when(last.finishedAt)} · {where}</span> — {text}</span>
        {!!last.trash?.files && <span className="flex flex-wrap items-center gap-2 text-xs" title={`回收目录：${last.trash.files.toLocaleString()} 个文件，回写时被删除或覆盖的旧版本，在 NAS 该文件夹的 .vim4-nasdisk/trash`}>
          <span className="text-muted-foreground">回收目录 {bytes(last.trash.bytes)}</span>
          <Button variant="outline" type="button" disabled={locked} onClick={() => onEmptyTrash(last.trash!)}>清空…</Button>
        </span>}
        <Button variant="outline" type="button" aria-label="隐藏上次结果" onClick={onHide}>×</Button>
      </div>
      {last.result === "failed" && <Detail text={last.detail} />}
      {last.conflicts.length > 0 && (
        <details className="text-xs [&_summary]:cursor-pointer [&_summary]:text-primary [&_p]:mt-2 [&_code]:mt-2 [&_code]:block [&_li]:mt-2" open>
          <summary>冲突项（{last.conflicts.length}）</summary>
          <ul>
            {last.conflicts.map((c) => (
              <li key={c.path}>
                <code className="font-mono break-all">{c.path}</code>
                <span className="text-muted-foreground">
                  {c.copy ? (
                    <>
                      NAS 上的文件在挂载期间被改过，电脑的版本保存为 <code className="font-mono break-all">{c.copy}</code>
                    </>
                  ) : (
                    "电脑删除了它，但 NAS 上的文件在挂载期间被改过，已保留"
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

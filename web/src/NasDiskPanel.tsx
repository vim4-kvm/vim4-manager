import { useEffect, useState } from "react";
import { nasDiskWrite, request, storageWrite, type NasDiskCounts, type NasDiskLast, type NasDiskSession, type NasDiskState, type Storage, type Status } from "./api";
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
    <section className="nasdisk reveal" aria-label="U 盘活动">
      {pending && (
        <span className="muted" role="status">
          <span className="spinner" aria-hidden="true" />
          {pending}
        </span>
      )}
      {state && !state.known && <p className="storage-warn">暂时无法读取 U 盘状态。</p>}

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
        <div className="nasdisk-pending">
          <h4>未写回的修改</h4>
          <p className="muted">板子重启或服务中断时，这些 U 盘修改还没有写回 NAS。</p>
          <ul>
            {state.pending.map((p) => (
              <li key={p.id}>
                <div>
                  <strong>
                    {p.storageName} › {displayPath(p.path)}
                  </strong>
                  <span className="muted">
                    {when(p.startedAt)} 挂载 · 已写入 {bytes(p.writtenBytes)}
                    {p.journal && " · 回写进行到一半"}
                  </span>
                </div>
                <button className="button small" disabled={locked || active} onClick={() => void act("正在回写…", () => nasDiskWrite("/commit", { id: p.id }))}>
                  写回 NAS
                </button>
                <button
                  className="button small"
                  disabled={locked || active}
                  onClick={() => setConfirming({ kind: "discard", id: p.id, name: `${p.storageName} › ${displayPath(p.path)}` })}
                >
                  放弃…
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {confirming && (
        <div className="confirm" role="alertdialog" aria-label={CONFIRM_TITLE[confirming.kind]}>
          <span>
            {confirming.kind === "discard"
              ? `放弃「${confirming.name}」中被控电脑做的全部修改。NAS 上的文件保持挂载前的样子，此操作无法撤销。`
              : confirming.kind === "trash"
                ? `永久删除回收目录中的 ${confirming.files.toLocaleString()} 个文件（${bytes(confirming.bytes)}）。它们是回写时被删除或覆盖的旧版本，删除后无法找回。`
                : "停止准备 U 盘。被控电脑还没有看到这个 U 盘。"}
          </span>
          <button className="button" onClick={() => setConfirming(undefined)}>
            返回
          </button>
          <button
            className="button danger"
            disabled={locked}
            onClick={() =>
              void (confirming.kind === "discard"
                ? act("正在放弃修改…", () => nasDiskWrite("/discard", { id: confirming.id, confirm: confirming.id }))
                : confirming.kind === "trash"
                  ? act("正在清空回收目录…", () => nasDiskWrite("/trash-empty", { id: confirming.id, confirm: confirming.id }))
                  : act("正在取消…", () => nasDiskWrite("/cancel", {})))
            }
          >
            {CONFIRM_TITLE[confirming.kind]}
          </button>
        </div>
      )}
      {error && <p className="storage-error" role="alert">{error}</p>}
    </section>
  );
}

export function NasDiskSetup({
  storage,
  status,
  locked,
  onCancel,
  onStart,
}: {
  storage: Storage;
  status?: Status;
  locked: boolean;
  onCancel: () => void;
  onStart: (setup: Setup) => void;
}) {
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
    <form
      className="storage-editor nasdisk-setup"
      onSubmit={(e) => {
        e.preventDefault();
        if (canStart) onStart({ ...setup, mode: readOnlyOnly ? "ro" : setup.mode });
      }}
    >
      <h4>选择要作为 U 盘的文件夹</h4>

      <div className="nasdisk-browser">
        <nav className="nasdisk-crumbs" aria-label="文件夹路径">
          <button type="button" className="link-button" aria-current={parts.length === 0 ? "location" : undefined} onClick={() => go("/")}>
            {storage?.name ?? "NAS"}
          </button>
          {parts.map((part, i) => (
            <span key={i}>
              <span className="muted" aria-hidden="true">
                ›
              </span>
              <button
                type="button"
                className="link-button"
                aria-current={i === parts.length - 1 ? "location" : undefined}
                onClick={() => go("/" + parts.slice(0, i + 1).join("/"))}
              >
                {part}
              </button>
            </span>
          ))}
        </nav>
        {dirError ? (
          <div className="storage-error nasdisk-dirs-note" role="alert">
            {dirError} <button type="button" className="link-button" onClick={() => setRetry((n) => n + 1)}>重试</button>
          </div>
        ) : !dirs ? (
          <p className="muted nasdisk-dirs-note">正在读取…</p>
        ) : dirs.names.length === 0 ? (
          <p className="muted nasdisk-dirs-note">没有子文件夹。</p>
        ) : (
          <ul className="nasdisk-dirs" aria-label="子文件夹">
            {dirs.names.map((name) => (
              <li key={name}>
                <button type="button" onClick={() => go(`${setup.path === "/" ? "" : setup.path}/${name}`)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  </svg>
                  <span>{name}</span>
                  <span className="nasdisk-enter" aria-hidden="true">›</span>
                </button>
              </li>
            ))}
            {dirs.truncated && <li className="muted nasdisk-dirs-note">只显示前 500 个文件夹</li>}
          </ul>
        )}
        {dirs && !readOnlyOnly && (
          <div className="nasdisk-mkdir">
            {newName === undefined ? (
              <button type="button" className="link-button" disabled={locked} onClick={() => setNewName("")}>
                <span aria-hidden="true">+ </span>新建文件夹
              </button>
            ) : (
              <>
                <div className="nasdisk-mkdir-row">
                  <input
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
                  <button type="button" className="button small primary" disabled={locked || creating || !nameTrimmed || !!nameProblem} onClick={() => void mkdir()}>
                    {creating ? "正在创建…" : "创建"}
                  </button>
                  <button type="button" className="button small" disabled={creating} onClick={() => setNewName(undefined)}>
                    取消
                  </button>
                </div>
                {(nameProblem || mkdirError) && <span className="field-hint nasdisk-mkdir-error">{nameProblem || mkdirError}</span>}
              </>
            )}
          </div>
        )}
        <p className="nasdisk-chosen">
          已选择 <strong>{storage.name} › {displayPath(setup.path)}</strong>
        </p>
      </div>

      <div className="segmented storage-types" role="group" aria-label="模式">
        <button type="button" aria-pressed={setup.mode === "rw" && !readOnlyOnly} disabled={readOnlyOnly} onClick={() => setSetup({ ...setup, mode: "rw" })}>
          <strong>可写</strong>
          <span>{readOnlyOnly ? "NAS 不允许写入" : "安全弹出后写回 NAS"}</span>
        </button>
        <button type="button" aria-pressed={setup.mode === "ro" || readOnlyOnly} onClick={() => setSetup({ ...setup, mode: "ro" })}>
          <strong>只读</strong>
          <span>电脑只能读取</span>
        </button>
      </div>

      {editingLabel ? (
        <label className="field nasdisk-label">
          卷标
          <input
            value={setup.label}
            autoFocus
            maxLength={11}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!labelValid}
            onChange={(e) => setSetup({ ...setup, label: e.target.value.toUpperCase(), labelEdited: true })}
          />
          {!labelValid && <span className="field-hint">1–11 个大写字母、数字、空格、下划线或连字符</span>}
        </label>
      ) : (
        <div className="nasdisk-label-summary">
          <span>卷标 <strong>{setup.label}</strong></span>
          <button type="button" className="link-button" onClick={() => setEditingLabel(true)}>修改</button>
        </div>
      )}

      <p className="muted nasdisk-note">
        单个文件不小于 4 GiB 或名称 U 盘不支持的文件不会出现在 U 盘里，也不会被删除。
      </p>
      {occupiedMedia && (
        <p className="storage-warn" role="status">
          虚拟介质已挂载「{mediaName(occupiedMedia)}」，先在<a className="link-button" href="#/media">虚拟介质页</a>弹出。
        </p>
      )}
      {status && status.hardware.usb !== "configured" && (
        <p className="storage-warn" role="status">被控电脑尚未通过 USB 连接，连接后即可看到 U 盘。</p>
      )}

      <div className="storage-editor-actions">
        <button type="button" className="button" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="button primary" disabled={!canStart}>
          挂载到被控电脑
        </button>
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
  const tone =
    s.state === "attached" ? (s.hostConnected ? "status-good" : "status-warning") : s.state === "needs-decision" || s.state === "failed" ? "status-critical" : "status-warning";
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
    <div className="nasdisk-session">
      <div className="storage-row">
        <span className={`lamp ${tone}`} aria-hidden="true" />
        <div className="storage-main">
          <div className="storage-name">
            <strong>
              U 盘 · {s.storageName} › {displayPath(s.path)}
            </strong>
            <span className="tag tag-quiet">{rw ? "可写" : "只读"}</span>
            <span className="tag tag-quiet">{s.label}</span>
          </div>
          <span key={s.state} className={`storage-state reveal ${tone}`} role="status">
            {(s.state === "scanning" || s.state === "attaching" || s.state === "parsing" || s.state === "committing") && (
              <span className="spinner" aria-hidden="true" />
            )}
            {title}
          </span>
          {s.state !== "scanning" && s.volumeBytes > 0 && (
            <span className="muted nasdisk-facts">
              {s.files.toLocaleString()} 个文件 · {s.dirs.toLocaleString()} 个文件夹 · 已用 {bytes(s.usedBytes)} / 容量 {bytes(s.volumeBytes)}
              {rw && s.writtenBytes > 0 && ` · 电脑已写入 ${bytes(s.writtenBytes)}`}
            </span>
          )}
        </div>
        <div className="storage-actions">
          {(s.state === "scanning" || s.state === "attaching") && (
            <button className="button small" disabled={locked} onClick={onCancel}>
              取消
            </button>
          )}
        </div>
      </div>

      {s.nasStalled && (s.state === "attached" || s.state === "committing") && (
        <p className="storage-warn" role="status">
          {s.state === "attached" ? "NAS 暂时无响应，电脑上读写这个 U 盘会出错；NAS 恢复后自动恢复。" : "NAS 暂时无响应，回写在等待。"}
        </p>
      )}
      {s.state === "attached" && (
        <div className="nasdisk-hint muted">
          <p>{rw ? "在电脑上安全弹出后，修改会写回 NAS。" : "在电脑上安全弹出后，即可结束这次 U 盘。"}</p>
          <details className="nasdisk-detail"><summary>如何安全弹出</summary><p>{hostEject}</p></details>
        </div>
      )}

      {s.state === "committing" && progress && (
        <div className="nasdisk-progress">
          <span className="meter">
            <span style={{ width: `${Math.max(2, ratio * 100)}%` }} />
          </span>
          <span className="muted">
            {progress.done} / {progress.total} 步{progress.bytesTotal > 0 && ` · ${bytes(progress.bytesDone)} / ${bytes(progress.bytesTotal)}`}
            {progress.current && ` · ${progress.current}`}
          </span>
        </div>
      )}
      {s.state === "committing" && s.plan && <p className="muted nasdisk-plan">{counts(s.plan) || "没有需要写回的修改"}</p>}

      {s.state === "needs-decision" && s.decision && (
        <div className="nasdisk-decision">
          <p>
            {s.decision.reason ||
              "被控电脑可能在写入完成前拔出了 U 盘，文件系统不完整。"}
            修改仍保存在 NAS 的暂存区，尚未写回。
          </p>
          <Detail text={s.detail} />
          <ul className="nasdisk-choices">
            <li>
              <button className="button primary" disabled={locked} onClick={onReattach}>
                重新挂载
              </button>
              <span className="muted">让电脑检查修复 U 盘，再安全弹出（推荐）</span>
            </li>
            {s.decision.canForce && (
              <li>
                <button className="button" disabled={locked} onClick={onForce}>
                  写回能识别的内容
                </button>
                <span className="muted">只写入完整读出的文件，不执行删除</span>
              </li>
            )}
            <li>
              <button className="button danger" disabled={locked} onClick={onDiscard}>
                放弃修改…
              </button>
              <span className="muted">NAS 保持挂载前的样子</span>
            </li>
          </ul>
        </div>
      )}

      {s.state === "failed" && (
        <div className="nasdisk-decision">
          <p>
            {s.error || "U 盘出错。"}
            {rw && " 未写回的修改仍保存在 NAS 的暂存区。"}
          </p>
          <Detail text={s.detail} />
          <ul className="nasdisk-choices">
            {rw && (
              <li>
                <button className="button primary" disabled={locked} onClick={onRetry}>
                  重试写回
                </button>
                <span className="muted">NAS 恢复访问后再试</span>
              </li>
            )}
            <li>
              <button className="button danger" disabled={locked} onClick={onDiscard}>
                {rw ? "放弃修改…" : "结束"}
              </button>
              <span className="muted">{rw ? "NAS 保持挂载前的样子" : "结束这次 U 盘"}</span>
            </li>
          </ul>
        </div>
      )}

      {s.skippedCount > 0 && (
        <div className="nasdisk-skipped">
          <button type="button" className="link-button" aria-expanded={showSkipped} onClick={() => setShowSkipped(!showSkipped)}>
            {s.skippedCount} 项未放入 U 盘
          </button>
          <span className="muted"> · 它们留在 NAS 上，不会被删除</span>
          {showSkipped && (
            <ul>
              {s.skipped.map((item) => (
                <li key={item.path}>
                  <code className="mono">{item.path}</code>
                  <span className="muted">{SKIP_REASONS[item.reason] ?? item.reason}</span>
                </li>
              ))}
              {s.skippedCount > s.skipped.length && <li className="muted">另有 {s.skippedCount - s.skipped.length} 项未列出</li>}
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
    <details className="nasdisk-detail">
      <summary>技术细节</summary>
      <code className="mono">{text}</code>
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
    <div className={`nasdisk-last${last.result === "failed" ? " is-failed" : ""}`}>
      <div className="nasdisk-last-line">
        <span className="nasdisk-last-summary"><span className="muted">上次 · {when(last.finishedAt)} · {where}</span> — {text}</span>
        {!!last.trash?.files && <span className="nasdisk-trash" title={`回收目录：${last.trash.files.toLocaleString()} 个文件，回写时被删除或覆盖的旧版本，在 NAS 该文件夹的 .vim4-nasdisk/trash`}>
          <span className="muted">回收目录 {bytes(last.trash.bytes)}</span>
          <button type="button" className="button small" disabled={locked} onClick={() => onEmptyTrash(last.trash!)}>清空…</button>
        </span>}
        <button type="button" className="button small" aria-label="隐藏上次结果" onClick={onHide}>×</button>
      </div>
      {last.result === "failed" && <Detail text={last.detail} />}
      {last.conflicts.length > 0 && (
        <details className="nasdisk-detail" open>
          <summary>冲突项（{last.conflicts.length}）</summary>
          <ul>
            {last.conflicts.map((c) => (
              <li key={c.path}>
                <code className="mono">{c.path}</code>
                <span className="muted">
                  {c.copy ? (
                    <>
                      NAS 上的文件在挂载期间被改过，电脑的版本保存为 <code className="mono">{c.copy}</code>
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

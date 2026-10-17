import { useCallback, useEffect, useState } from "react";
import { request, storageWrite, type Storage, type StorageConfig, type StorageState, type StorageTest, type StorageType } from "./api";
import { bytes } from "./DiskPanel";
import { CopyButton, PasswordInput } from "./Icons";
import { NasDiskPanel } from "./NasDiskPanel";

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

function stateLabel(s: Storage): { tone: string; text: string } {
  if (s.state === "mounting") return { tone: "status-warning", text: "正在连接" };
  if (s.mounted && s.stale) return { tone: "status-warning", text: "已连接 · 无响应" };
  if (s.mounted) return { tone: "status-good", text: s.writable === false ? "已连接 · 只读" : "已连接" };
  if (s.state === "error") return { tone: "status-critical", text: "连接失败" };
  return { tone: "", text: "未连接" };
}

export function StoragePanel({ busy }: { busy: boolean }) {
  const [state, setState] = useState<StorageState>();
  const [stale, setStale] = useState(true);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<Editor>();
  const [test, setTest] = useState<StorageTest & { running?: boolean }>();
  const [confirming, setConfirming] = useState<Confirm>();
  const [diskSetup, setDiskSetup] = useState<string>();
  const clearDiskSetup = useCallback(() => setDiskSetup(undefined), []);

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
    <>
    {storages.length > 0 && (
      <NasDiskPanel
        storages={storages}
        setupFor={diskSetup}
        onSetupDone={clearDiskSetup}
        locked={busy || stale}
      />
    )}
    <section className="storage" aria-label="网络存储">
      <div className="storage-head">
        <div>
          <h3>NAS 连接</h3>
          <p className="muted">连接后可在板子上直接使用 NAS 的空间，断开不会删除 NAS 上的文件。</p>
        </div>
        <div className="storage-head-action">
          {pending && (
            <span className="muted" role="status">
              <span className="spinner" aria-hidden="true" />
              {pending}
            </span>
          )}
          {!editor && (
            <button className="button primary" disabled={locked || storages.length >= 8} onClick={() => openEditor()}>
              添加 NAS
            </button>
          )}
        </div>
      </div>

      {missingTools && (
        <p className="storage-note">
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
        <p className="storage-empty muted">{stale ? "正在读取…" : ""}</p>
      ) : storages.length === 0 && !editor ? (
        <div className="storage-empty">
          <strong>还没有连接 NAS</strong>
          <span className="muted">支持 Windows 共享、macOS 文件共享、群晖、威联通等的 SMB，以及 Linux 和 NAS 的 NFS 导出。</span>
        </div>
      ) : (
        <ul className="storage-list" aria-label="NAS 连接">
          {storages.map((s) => {
            const status = stateLabel(s);
            const room = capacity(s);
            const open = editor?.editing && editor.draft.id === s.id;
            return (
              <li key={s.id} className={open ? "is-open" : undefined}>
                <div className="storage-row">
                  <span className={`lamp ${status.tone}`} aria-hidden="true" />
                  <div className="storage-main">
                    <div className="storage-name">
                      <strong>{s.name}</strong>
                      <span className="tag tag-quiet">{s.type.toUpperCase()}</span>
                      {s.insecure && <span className="tag tag-warning">SMB 1.0</span>}
                      <span className={`storage-state ${status.tone}`}>{status.text}</span>
                    </div>
                    <span className="storage-address mono">{storageAddress(s)}</span>
                    {room && (
                      <div className="storage-room">
                        {room.ratio !== undefined && (
                          <span className={`meter${room.ratio > 0.95 ? " meter-critical" : room.ratio > 0.85 ? " meter-warning" : ""}`}>
                            <span style={{ width: `${Math.max(2, room.ratio * 100)}%` }} />
                          </span>
                        )}
                        <span className="muted">{room.text}</span>
                      </div>
                    )}
                    {s.mounted && s.writable === false && (
                      <span className="storage-warn">板子没有写入权限，录制和 U 盘回写不可用。请在 NAS 上给该账户写入权限。</span>
                    )}
                    {!s.mounted && s.error && <span className="storage-error">{s.error}</span>}
                  </div>
                    <div className="storage-actions">
                    {s.mounted && (
                      <button
                        className="button small"
                        disabled={locked}
                        onClick={() => {
                          setDiskSetup(s.id);
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }}
                      >
                        作为 U 盘…
                      </button>
                    )}
                    {s.mounted ? (
                      <button className="button small" disabled={locked} onClick={() => setConfirming({ kind: "unmount", storage: s })}>
                        断开
                      </button>
                    ) : (
                      <button
                        className="button small"
                        disabled={locked || s.state === "mounting"}
                        onClick={() => void act(`正在连接「${s.name}」…`, () => storageWrite("/mount", { id: s.id }))}
                      >
                        连接
                      </button>
                    )}
                    <button className="button small" disabled={locked} aria-expanded={!!open} onClick={() => (open ? setEditor(undefined) : openEditor(s))}>
                      编辑
                    </button>
                  </div>
                </div>

                {open && (
                  <>
                    <dl className="storage-facts">
                      <div>
                        <dt>板上路径</dt>
                        <dd>
                          <span className="storage-path">
                            <code className="mono">{s.path}</code>
                            <CopyButton text={s.path} label="复制路径" />
                          </span>
                        </dd>
                      </div>
                    </dl>
                    <StorageEditor
                      editor={editor}
                      setEditor={setEditor}
                      test={test}
                      tools={state.tools}
                      locked={locked}
                      onTest={() => void runTest()}
                      onSave={() => void save()}
                      onCancel={() => (setEditor(undefined), setTest(undefined))}
                      onDelete={() => setConfirming({ kind: "delete", storage: s })}
                    />
                  </>
                )}

                {confirming?.storage.id === s.id && (
                  <div className="confirm" role="alertdialog" aria-label={confirming.kind === "delete" ? "删除连接" : "断开"}>
                    <span>
                      {confirming.kind === "delete"
                        ? `删除「${s.name}」的连接设置和保存的密码${s.mounted ? "，并先断开" : ""}。NAS 上的文件不受影响。`
                        : `断开「${s.name}」。正在使用它的录制或 U 盘会阻止断开，需先停止录制或安全弹出。`}
                    </span>
                    <button className="button" onClick={() => setConfirming(undefined)}>
                      取消
                    </button>
                    <button
                      className="button danger"
                      disabled={locked}
                      onClick={() =>
                        void (confirming.kind === "delete"
                          ? act(`正在删除「${s.name}」…`, () => storageWrite("/delete", { id: s.id, confirm: s.name })).then(
                              (ok) => ok && setEditor(undefined),
                            )
                          : act(`正在断开「${s.name}」…`, () => storageWrite("/unmount", { id: s.id })))
                      }
                    >
                      {confirming.kind === "delete" ? "删除连接" : "断开"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <p className="storage-error" role="alert">
          {error}
        </p>
      )}
    </section>
    </>
  );
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
  onDelete,
}: {
  editor: Editor;
  setEditor: (e: Editor) => void;
  test?: StorageTest & { running?: boolean };
  tools?: { smb: boolean; nfs: boolean };
  locked: boolean;
  onTest: () => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const d = editor.draft;
  const set = (patch: Partial<StorageConfig>) => setEditor({ ...editor, draft: { ...d, ...patch } });
  const invalid = draftError(d);
  const smb = d.type === "smb";
  const toolMissing = tools && !tools[d.type];

  return (
    <form
      className="storage-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid && !locked) onSave();
      }}
    >
      {!editor.editing && (
        <div className="segmented storage-types" role="group" aria-label="协议">
          <button type="button" aria-pressed={smb} onClick={() => set({ type: "smb", version: "auto" })}>
            <strong>SMB</strong>
            <span>Windows、macOS、大多数 NAS</span>
          </button>
          <button type="button" aria-pressed={!smb} onClick={() => set({ type: "nfs", version: "auto", username: "", domain: "" })}>
            <strong>NFS</strong>
            <span>Linux 与 NAS 的 NFS 导出</span>
          </button>
        </div>
      )}

      <div className="storage-grid">
        <label className="field">
          服务器
          <input
            value={d.server}
            autoFocus={!editor.editing}
            autoComplete="off"
            spellCheck={false}
            placeholder="192.168.1.10 或 nas.local"
            onChange={(e) => set({ server: e.target.value })}
          />
        </label>
        <label className="field">
          {smb ? "共享名" : "导出路径"}
          <input
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
            <label className="field">
              用户名
              <input
                value={d.username}
                autoComplete="off"
                spellCheck={false}
                placeholder="留空为访客访问"
                onChange={(e) => set({ username: e.target.value })}
              />
            </label>
            <label className="field">
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
        <label className="field">
          名称
          <input value={d.name} autoComplete="off" placeholder={defaultName(d) || "NAS"} maxLength={40} onChange={(e) => set({ name: e.target.value })} />
        </label>
      </div>

      {(d.server || d.share) && (
        <p className="storage-preview muted">
          将连接 <code className="mono">{storageAddress({ ...d, server: d.server.trim(), share: d.share.trim() })}</code>
        </p>
      )}

      <div className="storage-options">
        <label className="media-check">
          <input type="checkbox" checked={d.autoMount} onChange={(e) => set({ autoMount: e.target.checked })} />
          开机自动连接
        </label>
        <button type="button" className="link-button" aria-expanded={editor.advanced} onClick={() => setEditor({ ...editor, advanced: !editor.advanced })}>
          高级选项
        </button>
      </div>

      {editor.advanced && (
        <div className="storage-grid storage-advanced">
          <label className="field">
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
            <label className="field">
              域 / 工作组
              <input value={d.domain} autoComplete="off" spellCheck={false} placeholder="通常留空" onChange={(e) => set({ domain: e.target.value })} />
            </label>
          )}
          {smb && d.version === "1.0" && <p className="storage-warn">SMB 1.0 没有加密且存在已知漏洞，只在老旧设备无法升级时使用。</p>}
        </div>
      )}

      {toolMissing && <p className="storage-warn">板子缺少 {smb ? "SMB" : "NFS"} 挂载工具，暂时无法连接。</p>}
      {test && <TestResult test={test} />}

      <div className="storage-editor-actions">
        {onDelete && (
          <button type="button" className="button danger storage-delete" disabled={locked} onClick={onDelete}>
            删除连接…
          </button>
        )}
        <button type="button" className="button" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="button" disabled={locked || !!invalid || !!toolMissing || test?.running} aria-busy={test?.running} onClick={onTest}>
          {test?.running && <span className="spinner" aria-hidden="true" />}
          测试连接
        </button>
        <button type="submit" className="button primary" disabled={locked || !!invalid || !!toolMissing} title={invalid || undefined}>
          {editor.editing ? "保存" : d.autoMount ? "保存并连接" : "保存"}
        </button>
      </div>
    </form>
  );
}

function TestResult({ test }: { test: StorageTest & { running?: boolean } }) {
  if (test.running) return <p className="storage-test muted">正在连接 NAS，最长约 15 秒…</p>;
  if (!test.ok) return <p className="storage-test storage-error">{test.error || "连接失败"}</p>;
  const parts = [
    test.freeBytes != null && test.totalBytes != null ? `剩余 ${bytes(test.freeBytes)} / ${bytes(test.totalBytes)}` : "",
    test.elapsedMs != null ? `${test.elapsedMs} ms` : "",
  ].filter(Boolean);
  return (
    <p className={`storage-test ${test.writable ? "storage-ok" : "storage-warn"}`}>
      {test.writable ? "连接成功，可以写入" : "可以读取，但没有写入权限"}
      {parts.length > 0 && <span className="muted"> · {parts.join(" · ")}</span>}
    </p>
  );
}

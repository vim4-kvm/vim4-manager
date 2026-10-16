import { useEffect, useState } from "react";
import { request, type Media, type MediaImage } from "./api";

const sources: Record<string, string> = { data: "数据盘", shared: "NanoKVM 镜像", jetkvm: "JetKVM", onekvm: "One-KVM", pikvm: "PiKVM" };
type Run = (label: string, action: () => Promise<unknown>, done: string) => Promise<boolean>;

export function needsMediaEject(media: Media | undefined, target: string): boolean {
  return !!media?.inserted && (target === "pikvm" || media.pikvm);
}

function size(bytes: number): string {
  return bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GiB` : `${(bytes / 2 ** 20).toFixed(1)} MiB`;
}

function MediaIcon({ cdrom, empty }: { cdrom?: boolean; empty?: boolean }) {
  return (
    <svg className={`media-icon${empty ? " is-empty" : ""}`} viewBox="0 0 24 24" aria-hidden="true">
      {cdrom ? (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <circle cx="12" cy="12" r="2.2" />
        </>
      ) : (
        <>
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M4 14h16M16.5 16.5h.01" />
        </>
      )}
    </svg>
  );
}

function MediaFacts({ media }: { media: Media }) {
  return (
    <span className="media-facts">
      <span className="tag tag-quiet">{media.cdrom ? "虚拟光盘" : "虚拟磁盘"}</span>
      <span className="tag tag-quiet">{media.readOnly ? "只读" : "可写"}</span>
      <span className={`status status-${media.connected ? "good" : "warning"}`}>
        <span className="lamp" aria-hidden="true" />
        {media.connected ? "USB 已连接" : "USB 未连接"}
      </span>
    </span>
  );
}

const hostEject = "在被控电脑上安全弹出此介质。Mac：访达侧栏中点击弹出按钮；Windows：使用“安全删除硬件”。仅关闭窗口或卸载卷不算弹出。";

export function MediaSummary({ media }: { media?: Media }) {
  if (media?.known && !media.inserted) return null;
  return (
    <a className="media-strip" href="#/media">
      {media?.known ? (
        <>
          <MediaIcon cdrom={media.cdrom} />
          <span className="media-strip-text">
            <strong>{media.name}</strong>
            <MediaFacts media={media} />
          </span>
        </>
      ) : (
        <>
          <MediaIcon empty />
          <span className="media-strip-text">
            <strong>无法读取虚拟介质状态</strong>
            <span className="muted">状态恢复前暂不能切换界面。</span>
          </span>
        </>
      )}
      <span className="media-strip-go">管理介质 →</span>
    </a>
  );
}

export function MediaWait({ media, target, onCancel }: { media?: Media; target: string; onCancel: () => void }) {
  return (
    <div className="media-wait" role="status">
      <div className="media-wait-head">
        <span className="spinner" aria-hidden="true" />
        <strong>等待安全弹出后切换到 {target}</strong>
        <button className="button small" onClick={onCancel}>
          取消等待
        </button>
      </div>
      {media?.inserted && (
        <p>
          <strong>{media.name}</strong> 仍挂载在被控电脑上。当前会话保持运行，检测到弹出后自动切换。
        </p>
      )}
      <p className="hint">{hostEject}</p>
      <p className="hint">最长等待 5 分钟；离开此页或连接中断会取消等待。</p>
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
      <section className="media-current" aria-label="当前介质">
        <div className="media-current-body">
          <MediaIcon empty />
          <div className="media-current-text">
            <h3>状态未知</h3>
            <p className="muted">暂时无法读取介质状态，请等待状态恢复。</p>
          </div>
        </div>
      </section>
    );
  }
  if (!media.inserted) {
    return (
      <section className="media-current" aria-label="当前介质">
        <div className="media-current-body">
          <MediaIcon empty />
          <div className="media-current-text">
            <h3>未挂载介质</h3>
            <p className="muted">从下方镜像库选择一个镜像，挂载到被控电脑。</p>
          </div>
        </div>
      </section>
    );
  }
  return (
    <section className="media-current is-inserted" aria-label="当前介质">
      <div className="media-current-body">
        <MediaIcon cdrom={media.cdrom} />
        <div className="media-current-text">
          <span className="media-eyebrow">已挂载到被控电脑</span>
          <h3>{media.name}</h3>
          <MediaFacts media={media} />
        </div>
        {!ejecting && (
          <button className="button" disabled={locked} onClick={() => setEjecting(true)}>
            弹出…
          </button>
        )}
      </div>
      {ejecting && (
        <div className="media-eject">
          <ol className="media-steps">
            <li>{hostEject}</li>
            <li>确认主机已停止使用后，再从这里移除。</li>
          </ol>
          <label className="media-check">
            <input type="checkbox" checked={confirmed} disabled={locked} onChange={(event) => setConfirmed(event.target.checked)} />
            被控电脑已停止使用磁盘并安全卸载
          </label>
          <div className="media-actions">
            <span className="muted">此操作无法替代主机上的安全移除；主机仍锁定介质时会拒绝弹出。</span>
            <button className="button" disabled={locked} onClick={() => setEjecting(false)}>
              取消
            </button>
            <button
              className="button primary"
              disabled={locked || !confirmed || !media.token}
              onClick={() => {
                setConfirmed(false);
                void run("正在弹出虚拟磁盘…", () => request("/api/media/eject", { token: media.token, confirmed: true }), "虚拟磁盘已弹出");
              }}
            >
              弹出虚拟磁盘
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function MediaPanel({ media, active, activeName, busy, run }: {
  media?: Media; active: string; activeName?: string; busy: boolean; run: Run;
}) {
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
  }, [reload]);
  const selected = images.find(image => image.id === imageID);
  const locked = busy || !media?.known;
  const readOnlyRequired = !!selected?.cdrom || active === "jetkvm";
  const groups = [...new Set(images.map(image => image.source))]
    .sort((a, b) => Object.keys(sources).indexOf(a) - Object.keys(sources).indexOf(b));
  const blocker = media?.inserted ? "先弹出当前介质，再挂载其他镜像。"
    : !activeName ? "需先启用一个 KVM 界面。"
    : !selected ? "选择一个镜像。"
    : `通过 ${activeName} 挂载，可能短暂重连 USB 键鼠。`;

  return (
    <>
      <CurrentMedia media={media} locked={locked} run={run} />
      <section className="section media-library" aria-label="镜像库">
        <div className="section-head">
          <h3>镜像库</h3>
          <p className="muted">数据盘与各 KVM 的 ISO/IMG 目录。数据盘在「数据盘」页新建和管理文件，ISO 请在对应 KVM 中上传。</p>
          <button className="button small media-refresh" disabled={busy || loading} onClick={() => setReload(value => value + 1)}>
            刷新
          </button>
        </div>
        {loading ? <div className="skeleton media-skeleton" />
          : error ? <p className="edid-error" role="alert">{error}</p>
          : images.length === 0 ? (
            <div className="media-empty">
              <MediaIcon empty />
              <p>尚无镜像。在「数据盘」页新建数据盘，或通过对应 KVM 上传 ISO/IMG 文件后刷新列表。</p>
            </div>
          ) : (
            <div className="media-list" role="radiogroup" aria-label="镜像文件">
              {groups.map(source => (
                <div key={source} className="media-group">
                  <h4>
                    {sources[source] ?? source}
                    {source === "data" && <a className="media-group-link" href="#/disks">管理文件 →</a>}
                  </h4>
                  {images.filter(image => image.source === source).map(image => (
                    <label key={image.id} className={`media-option${image.id === imageID ? " is-checked" : ""}`}>
                      <input
                        type="radio"
                        name="media-image"
                        value={image.id}
                        checked={image.id === imageID}
                        disabled={locked}
                        onChange={() => { setImageID(image.id); setReadonly(true); }}
                      />
                      <MediaIcon cdrom={image.cdrom} />
                      <span className="media-option-name">{image.name}</span>
                      <span className="media-option-meta num">{image.cdrom ? "光盘" : "磁盘"} · {size(image.size)}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}
        <div className="media-mount">
          <label className="media-check">
            <input
              type="checkbox"
              checked={readonly || readOnlyRequired}
              disabled={locked || !!media?.inserted || readOnlyRequired}
              onChange={(event) => setReadonly(event.target.checked)}
            />
            只读挂载{readOnlyRequired ? "（光盘或 JetKVM 必须只读）" : ""}
          </label>
          <span className="muted">{blocker}</span>
          <button
            className="button primary"
            disabled={locked || loading || !!media?.inserted || !selected || !active}
            onClick={() => {
              if (selected) void run("正在挂载虚拟磁盘…", () => request("/api/media/mount", { app: active, image: selected.id, cdrom: selected.cdrom, readOnly: readonly || readOnlyRequired }), "虚拟磁盘已挂载");
            }}
          >
            挂载镜像
          </button>
        </div>
      </section>
    </>
  );
}

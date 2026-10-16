import { useEffect, useState } from "react";
import { request, type Media, type MediaImage } from "./api";

const sources: Record<string, string> = { shared: "NanoKVM 镜像", data: "共享数据盘", jetkvm: "JetKVM", onekvm: "One-KVM", pikvm: "PiKVM" };
type Run = (label: string, action: () => Promise<unknown>, done: string) => Promise<boolean>;

export function needsMediaEject(media: Media | undefined, target: string): boolean {
  return !!media?.inserted && (target === "pikvm" || media.pikvm);
}

export function MediaPanel({ media, active, busy, run, waiting, onCancel }: {
  media?: Media; active: string; busy: boolean; run: Run; waiting?: string; onCancel: () => void;
}) {
  const [images, setImages] = useState<MediaImage[]>([]);
  const [imageID, setImageID] = useState("");
  const [readonly, setReadonly] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
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
  useEffect(() => { setConfirmed(false); }, [media?.token, media?.inserted, media?.known, active, waiting]);
  const selected = images.find(image => image.id === imageID);
  const locked = busy || !!waiting || !media?.known;
  const readOnlyRequired = !!selected?.cdrom || active === "jetkvm";
  return <section className="section media-panel" aria-label="共享虚拟磁盘">
    <header className="section-head"><h3>共享虚拟磁盘</h3></header>
    <p>四套 KVM 共用此设备；磁盘名称不代表当前运行的 KVM。</p>
    {!media?.known ? <p role="status">暂时无法读取介质状态，请等待状态恢复后再切换。</p>
      : media.inserted ? <>
        <p><strong>{media.name}</strong> · {media.cdrom ? "虚拟光盘" : "虚拟磁盘"} · {media.readOnly ? "只读" : "可写"} · {media.connected ? "USB 已连接" : "已挂载，USB 未连接"}</p>
        <p>请在被控电脑上安全弹出此磁盘。Mac：访达中点击磁盘旁的弹出按钮；Windows：使用“安全删除硬件”。仅关闭窗口或卸载卷不算弹出。</p>
        {!waiting && <>
          <label><input type="checkbox" checked={confirmed} disabled={locked} onChange={event => setConfirmed(event.target.checked)} /> 被控电脑已停止使用磁盘并安全卸载</label>
          <p><button className="button" disabled={locked || !confirmed || !media.token} onClick={() => {
            setConfirmed(false);
            void run("正在弹出虚拟磁盘…", () => request("/api/media/eject", { token: media.token, confirmed: true }), "虚拟磁盘已弹出");
          }}>弹出虚拟磁盘</button></p>
          <p className="hint">此按钮无法替代被控电脑的安全移除操作；主机仍锁定介质时会拒绝弹出。</p>
        </>}
      </> : <p>未挂载虚拟磁盘</p>}
    <div className="media-library">
      <p>已有镜像可在这里挂载到被控电脑。挂载时可能短暂重连 USB 键鼠。</p>
      <label>镜像文件 <select aria-label="镜像文件" value={imageID} disabled={locked || loading || media?.inserted} onChange={event => { setImageID(event.target.value); setReadonly(true); }}>
        <option value="">{loading ? "正在读取…" : "选择已有镜像"}</option>
        {images.map(image => <option key={image.id} value={image.id}>{sources[image.source] ?? image.source} · {image.name} · {(image.size / 1048576).toFixed(1)} MiB</option>)}
      </select></label>
      <p><label><input type="checkbox" checked={readonly || readOnlyRequired} disabled={locked || media?.inserted || readOnlyRequired} onChange={event => setReadonly(event.target.checked)} /> 只读挂载{readOnlyRequired ? "（光盘或 JetKVM 必须只读）" : ""}</label></p>
      <div className="actions">
        <button className="button primary" disabled={locked || loading || !!media?.inserted || !selected || !active} onClick={() => {
          if (selected) void run("正在挂载虚拟磁盘…", () => request("/api/media/mount", { app: active, image: selected.id, cdrom: selected.cdrom, readOnly: readonly || readOnlyRequired }), "虚拟磁盘已挂载");
        }}>挂载镜像</button>
        <button className="button" disabled={busy || loading} onClick={() => setReload(value => value + 1)}>刷新镜像列表</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!loading && !error && images.length === 0 && <p>尚无镜像，请先通过对应 KVM 上传 ISO 或 IMG 文件，再刷新列表。</p>}
    </div>
    {waiting && <div role="status">
      <p>等待安全弹出后切换到 {waiting}。当前会话保持运行；弹出后会断开并自动切换。</p>
      <p className="hint">最长等待 5 分钟；离开此页或连接中断会取消等待。</p>
      <button className="button" onClick={onCancel}>取消等待</button>
    </div>}
  </section>;
}

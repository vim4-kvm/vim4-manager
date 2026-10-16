import type { Media } from "./api";

export function needsMediaEject(media: Media | undefined, target: string): boolean {
  return !!media?.inserted && (target === "pikvm" || media.pikvm);
}

export function MediaPanel({ media, waiting, onCancel }: {
  media?: Media; waiting?: string; onCancel: () => void;
}) {
  return <section className="section media-panel" aria-label="共享虚拟磁盘">
    <header className="section-head"><h3>共享虚拟磁盘</h3></header>
    <p>四套 KVM 共用此设备；磁盘名称不代表当前运行的 KVM。</p>
    {!media?.known ? <p role="status">暂时无法读取介质状态，请等待状态恢复后再切换。</p>
      : media.inserted ? <>
        <p><strong>{media.name}</strong> · {media.cdrom ? "虚拟光盘" : "虚拟磁盘"} · {media.readOnly ? "只读" : "可写"} · {media.connected ? "USB 已连接" : "已挂载，USB 未连接"}</p>
        <p>请在被控电脑上安全弹出此磁盘。Mac：访达中点击磁盘旁的弹出按钮；Windows：使用“安全删除硬件”。仅关闭窗口或卸载卷不算弹出。</p>
      </> : <p>未挂载虚拟磁盘</p>}
    {waiting && <div role="status">
      <p>等待安全弹出后切换到 {waiting}。当前会话保持运行；弹出后会断开并自动切换。</p>
      <p className="hint">最长等待 5 分钟；离开此页或连接中断会取消等待。</p>
      <button className="button" onClick={onCancel}>取消等待</button>
    </div>}
  </section>;
}

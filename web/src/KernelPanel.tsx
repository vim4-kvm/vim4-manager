import { useEffect, useState } from "react";
import { request } from "./api";

interface Kernel {
  id: string;
  name: string;
  release: string;
  selected: boolean;
  available: boolean;
  error: string;
}
interface KernelState { running: string; kernels: Kernel[] }

export function KernelPanel({ busy, run }: {
  busy: boolean;
  run: (label: string, action: () => Promise<unknown>, done: string) => Promise<boolean>;
}) {
  const [state, setState] = useState<KernelState>();
  const [error, setError] = useState<string>();
  const [choice, setChoice] = useState<Kernel>();
  const [rebooting, setRebooting] = useState(false);
  useEffect(() => {
    if (busy || rebooting) return;
    const controller = new AbortController();
    request<KernelState>("/api/kernel", undefined, controller.signal)
      .then(value => { setState(value); setError(undefined); })
      .catch(e => { if (!controller.signal.aborted) setError(String(e)); });
    return () => controller.abort();
  }, [busy, rebooting]);

  const apply = async () => {
    if (!choice) return;
    const ok = await run("切换内核", () => request("/api/kernel", {
      id: choice.id, reboot: true,
    }), "已保存默认内核，设备即将重启");
    if (ok) { setRebooting(true); setChoice(undefined); }
  };

  return <div>
    <p>当前内核：{state?.running ?? "正在读取…"}</p>
    <p className="muted">同一应用的账户、设置和镜像在两个内核间共用。切换会中断当前连接并重启设备，请先在被控电脑安全弹出虚拟磁盘。</p>
    {error && <p role="alert">{error}</p>}
    {state && state.kernels.length === 0 && <p className="muted">尚未登记可切换的内核。</p>}
    {state?.kernels.map(kernel => <div key={kernel.id} className="edid-fact">
      <span>{kernel.name} · {kernel.release}{kernel.selected ? " · 默认启动" : ""}</span>{" "}
      <button disabled={busy || rebooting || !kernel.available} onClick={() => setChoice(kernel)}>选择并重启</button>
      {kernel.error && <p role="alert">{kernel.error}</p>}
    </div>)}
    {choice && <div role="alert">
      <p>将默认启动内核设为 {choice.name} 并立即重启？设备启动失败时需要通过串口或 OOWOW 恢复。</p>
      <button disabled={busy} onClick={() => void apply()}>确认重启</button>{" "}
      <button disabled={busy} onClick={() => setChoice(undefined)}>取消</button>
    </div>}
    {rebooting && <p role="status">设备正在重启，启动完成后请刷新此页面。</p>}
  </div>;
}

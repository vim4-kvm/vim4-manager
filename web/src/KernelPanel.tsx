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

  return <div className="kernel-panel">
    <div className="updates-head">
      <span className="muted">当前运行 <span className="mono">{state?.running ?? "正在读取…"}</span> · 同一应用的账户、设置和镜像共用</span>
    </div>
    {error && <p className="edid-error" role="alert">{error}</p>}
    {state && state.kernels.length === 0 && <p className="muted">尚未登记可切换的内核。</p>}
    {state && state.kernels.length > 0 && <ul className="apps">
      {state.kernels.map(kernel => <li key={kernel.id} className={`app-row${kernel.selected ? " is-selected" : ""}`}>
        <div className="app-name">
          <h3>{kernel.name}{kernel.release === "7.3.0-vim4kvm-uhd1+" && <span className="tag">正式版</span>}{kernel.selected && <span className="tag">默认启动</span>}</h3>
          <p className="mono">{kernel.release}</p>
        </div>
        <div className="app-state">
          <span className={`status status-${kernel.available ? "good" : "warning"}`}>
            <span className="lamp" aria-hidden="true" />
            {kernel.error || (kernel.release === state.running ? "正在运行" : kernel.available ? "可切换" : "不可用")}
          </span>
        </div>
        <div className="app-actions">
          <button className="button" disabled={busy || rebooting || !kernel.available || !!choice}
            onClick={() => setChoice(kernel)}>{kernel.release === state.running ? "重启此内核" : "切换并重启"}</button>
        </div>
        {choice?.id === kernel.id && <div className="confirm" role="alertdialog" aria-label={`切换到 ${kernel.name}`}>
          <span>将默认启动设为 {kernel.name} 并重启，当前连接会断开。请先安全弹出虚拟磁盘；启动失败时需通过串口或 OOWOW 恢复。</span>
          <button className="button" disabled={busy} onClick={() => setChoice(undefined)}>取消</button>
          <button className="button primary" disabled={busy} onClick={() => void apply()}>确认重启</button>
        </div>}
      </li>)}
    </ul>}
    {rebooting && <p role="status">设备正在重启，启动完成后请刷新此页面。</p>}
  </div>;
}

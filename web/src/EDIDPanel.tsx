import { useEffect, useState } from "react";
import { request } from "./api";

interface EDIDState {
  presets: { id: string; name: string; description: string }[];
  selected: string;
  savedName: string;
  active: string;
  activeKnown: boolean;
  jetkvmSynced: boolean;
}

export function EDIDPanel({ busy, run }: {
  busy: boolean;
  run: (label: string, action: () => Promise<unknown>, done: string) => Promise<void>;
}) {
  const [state, setState] = useState<EDIDState>();
  const [choice, setChoice] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (busy) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await request<EDIDState>("/api/edid", undefined, controller.signal);
        if (!controller.signal.aborted) { setState(next); setError(undefined); }
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 5000);
      }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [busy]);
  const selected = choice ?? state?.selected ?? "";
  const preset = state?.presets.find(p => p.id === selected);
  const name = (id: string) => state?.presets.find(p => p.id === id)?.name ?? "自定义 EDID";
  return <section>
    <div className="section-head"><h2>显示器兼容性 · EDID</h2></div>
    <div className="app-card" style={{ display: "block" }}>
    <p className="muted">选择被控电脑识别到的显示器能力。切换可能短暂黑屏并改变桌面布局；JetKVM 正在运行时会重启。</p>
    {error && <p role="alert">读取失败：{error}</p>}
    {!state && !error && <p className="muted">正在读取 EDID…</p>}
    {state && <>
      <p>已保存：{state.selected ? name(state.selected) : state.savedName || "自定义 EDID"}；
        最近加载记录：{state.activeKnown ? name(state.active) : "未知"}。
        {!state.jetkvmSynced && " JetKVM 配置不同，应用预设后将同步。"}</p>
      <label>EDID 预设 <select value={selected} disabled={busy || !!error}
        onChange={event => setChoice(event.target.value)}>
        {!preset && <option value="">选择预设</option>}
        {state.presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>{" "}
      <button className="button primary" disabled={busy || !!error || !preset}
        onClick={() => void run("正在应用 EDID…", async () => {
          await request("/api/edid", { id: selected });
          setChoice(undefined);
        }, "EDID 已应用并保存，JetKVM 配置已同步")}>应用预设</button>
      <p className="muted">{preset?.description}</p>
    </>}
    </div>
  </section>;
}

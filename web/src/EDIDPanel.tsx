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

function Fact({ label, value, tone }: { label: string; value: string; tone: "good" | "warning" | "idle" }) {
  return (
    <div className="edid-fact">
      <dt>{label}</dt>
      <dd>
        <span className={`lamp status-${tone}`} aria-hidden="true" />
        {value}
      </dd>
    </div>
  );
}

export function EDIDPanel({ busy, run }: {
  busy: boolean;
  run: (label: string, action: () => Promise<unknown>, done: string) => Promise<boolean>;
}) {
  const [state, setState] = useState<EDIDState>();
  const [choice, setChoice] = useState<string>();
  const [confirming, setConfirming] = useState(false);
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

  if (!state) {
    return <div>
      {error ? <p className="edid-error" role="alert">读取失败：{error}</p> : <p className="muted">正在读取 EDID…</p>}
    </div>;
  }

  const name = (id: string) => state.presets.find(p => p.id === id)?.name;
  const selected = choice ?? state.selected;
  const target = state.presets.find(p => p.id === selected);
  // Applying the saved preset again still loads it and synchronizes JetKVM.
  const inSync = selected === state.selected && state.activeKnown && state.active === state.selected && state.jetkvmSynced;
  const apply = async () => {
    setConfirming(false);
    if (await run(`正在应用 EDID：${target!.name}…`, () => request("/api/edid", { id: selected }),
      `EDID 已切换为 ${target!.name}，JetKVM 配置已同步`)) setChoice(undefined);
  };

  return <div className="edid">
    <dl className="edid-facts">
      <Fact label="已保存" value={name(state.selected) ?? (state.savedName || "自定义 EDID")}
        tone={state.selected ? "good" : "warning"} />
      <Fact label="本次开机加载" value={state.activeKnown ? name(state.active) ?? "自定义 EDID" : "未记录"}
        tone={!state.activeKnown ? "idle" : state.active === state.selected ? "good" : "warning"} />
      <Fact label="JetKVM" value={state.jetkvmSynced ? "已同步" : "配置不同"} tone={state.jetkvmSynced ? "good" : "warning"} />
    </dl>
    {error && <p className="edid-error" role="alert">刷新失败：{error}，显示的是上次读取的状态。</p>}

    <div className="edid-options" role="radiogroup" aria-label="EDID 预设">
      {state.presets.map(p => {
        const checked = p.id === selected;
        return <label key={p.id} className={`edid-option${checked ? " is-checked" : ""}`}>
          <input type="radio" name="edid" value={p.id} checked={checked} disabled={busy}
            onChange={() => { setChoice(p.id); setConfirming(false); }} />
          <span className="edid-option-body">
            <span className="edid-option-head">
              <strong>{p.name}</strong>
              <span className="edid-tags">
                {p.id === state.selected && <span className="tag">已保存</span>}
                {state.activeKnown && p.id === state.active && <span className="tag tag-quiet">已加载</span>}
              </span>
            </span>
            <span className="muted">{p.description}</span>
          </span>
        </label>;
      })}
    </div>

    <div className="edid-actions">
      {confirming ? <div className="confirm" role="alertdialog" aria-label="确认切换 EDID">
        <span>被控电脑会重新识别显示器，可能短暂黑屏或改变桌面布局；JetKVM 运行中会重启。</span>
        <button className="button" onClick={() => setConfirming(false)}>取消</button>
        <button className="button primary" disabled={busy} onClick={() => void apply()}>切换</button>
      </div> : <>
        <span className="muted">
          {inSync ? "所选预设已保存并加载。" : !state.jetkvmSynced && selected === state.selected
            ? "重新应用可同步 JetKVM 配置。" : "应用后保存，重启仍然有效。"}
        </span>
        {choice !== undefined && choice !== state.selected &&
          <button className="button" disabled={busy} onClick={() => setChoice(undefined)}>撤销</button>}
        <button className="button primary" disabled={busy || !target || inSync} onClick={() => setConfirming(true)}>
          应用预设
        </button>
      </>}
    </div>
  </div>;
}

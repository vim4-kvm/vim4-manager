import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { request, type PassthroughState } from "./api";

const labels: Record<PassthroughState["state"], string> = {
  unsupported: "当前内核不支持",
  off: "已关闭",
  starting: "正在开启…",
  stopping: "正在关闭…",
  running: "透传中",
  "no-signal": "等待输入信号",
  "no-monitor": "未连接显示器",
  protected: "输入受版权保护",
};

const descriptions = {
  unsupported: <>当前内核没有透传功能，可在「<a href="#/updates">更新 → 内核</a>」中切换到支持透传的版本。</>,
  off: "开启后显示器显示被控电脑的画面；关闭时显示系统控制台。",
  running: "远程 KVM 不受影响。被控电脑切换分辨率时，显示器会短暂黑屏后跟随。",
  "no-signal": "HDMI IN 没有信号，显示器保持黑屏，信号恢复后自动继续。",
  "no-monitor": "接上显示器后自动开始透传。",
  protected: "被控电脑正在播放受 HDCP 保护的内容，显示器保持黑屏。",
};

function refreshLabel(hz: number) {
  return `${Number(hz.toFixed(2))}Hz`;
}

function mode(width: number, height: number, hz: number) {
  return `${width}×${height} ${refreshLabel(hz)}`;
}

function Fact({ label, value, detail, tone = "idle" }: {
  label: string; value: string; detail?: string; tone?: "good" | "warning" | "idle";
}) {
  return <div className="edid-fact">
    <dt>{label}</dt>
    <dd><span className={`lamp status-${tone}`} aria-hidden="true" /><span>{value}</span></dd>
    {detail && <dd className="muted passthrough-detail">{detail}</dd>}
  </div>;
}

function SwitchRow({ title, description, label, checked, disabled, pending, inactive, onToggle }: {
  title: string; description: string; label: string; checked: boolean; disabled: boolean; pending?: boolean; inactive?: boolean; onToggle: () => void;
}) {
  return <div className="wifi-row passthrough-row">
    <h3>{title}</h3>
    <div className="wifi-action">
      <span className="muted" role="status">{pending && <span className="spinner" aria-hidden="true" />}{label}</span>
      <button type="button" className={`wifi-switch${inactive ? " is-inactive" : ""}`} role="switch" aria-label={title} aria-checked={checked}
        disabled={disabled} onClick={onToggle}><span /></button>
    </div>
    <p className="muted">{description}</p>
  </div>;
}

export function PassthroughPanel({ busy, stale, run, onState }: {
  busy: boolean;
  stale: boolean;
  run: (label: string, action: () => Promise<unknown>, done: string) => Promise<boolean>;
  onState: (state: PassthroughState) => void;
}) {
  const [state, setState] = useState<PassthroughState>();
  const [error, setError] = useState<string>();
  const [readStale, setReadStale] = useState(true);
  const [pending, setPending] = useState<"starting" | "stopping" | "audio">();
  const [description, setDescription] = useState<ReactNode>(descriptions.off);
  const mounted = useRef(false);
  const actionPending = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const accept = useCallback((next: PassthroughState) => {
    setState(next);
    setError(undefined);
    setReadStale(false);
    onState(next);
    if (next.state !== "starting" && next.state !== "stopping") setDescription(descriptions[next.state]);
  }, [onState]);

  useEffect(() => {
    if (busy || pending) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await request<PassthroughState>("/api/passthrough", undefined,
          AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
        if (!controller.signal.aborted && !actionPending.current) accept(next);
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : String(e));
          setReadStale(true);
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 2000);
      }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [busy, pending, accept]);

  async function change(body: { enabled?: boolean; audio?: boolean }) {
    if (actionPending.current) return;
    actionPending.current = true;
    const transition = body.enabled === undefined ? "audio" : body.enabled ? "starting" : "stopping";
    setPending(transition);
    const verb = body.enabled === undefined ? "保存声音设置" : body.enabled ? "开启透传" : "关闭透传";
    await run(transition === "audio" ? "正在保存声音设置…" : labels[transition], async () => {
      try {
        const next = await request<PassthroughState>("/api/passthrough", body, AbortSignal.timeout(20000));
        if (mounted.current) accept(next);
      } catch (e) {
        throw new Error(`${verb}失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }, body.enabled === undefined ? "声音设置已保存" : body.enabled ? "透传已开启" : "透传已关闭");
    // A failed or lost response may still have changed the kernel. Keep the
    // old facts and lock controls until a fresh GET establishes actual state.
    if (mounted.current) {
      setReadStale(true);
      setPending(undefined);
    }
    actionPending.current = false;
  }

  if (!state) return <section aria-label="透传"><div className="wifi-card passthrough-card">
    {error ? <p className="edid-error" role="alert">读取失败：{error}</p> : <p className="muted">正在读取透传状态…</p>}
  </div></section>;

  const current = pending && pending !== "audio" ? pending : state.state;
  const transitioning = current === "starting" || current === "stopping";
  const locked = busy || stale || readStale || !!pending || transitioning || !state.supported;
  const enabled = current === "starting" || (current !== "stopping" && current !== "unsupported" && state.enabled);
  const input = state.input;
  const monitor = state.monitor;
  const output = state.output;
  let outputValue = state.state === "off" || state.state === "unsupported" ? "系统控制台" : "—";
  let outputDetail: string | undefined;
  let outputTone: "good" | "warning" | "idle" = "idle";
  if (state.state === "no-signal" || state.state === "protected") outputValue = "黑屏";
  if (state.state === "running" && output) {
    outputValue = mode(output.width, output.height, output.refreshHz);
    outputTone = output.scaled ? "warning" : "good";
    outputDetail = output.scaled && input
      ? `已缩放，显示器不支持 ${mode(input.width, input.height, input.refreshHz)}` : output.colorFormat;
    if (output.hdrToSdr || (input && input.hdr !== "SDR" && monitor && !monitor.hdr)) {
      outputDetail = output.scaled ? `${outputDetail} · HDR 已转为 SDR（使用视频输入页的曲线）`
        : "HDR 已转为 SDR（使用视频输入页的曲线）";
    }
  }
  if (transitioning) {
    outputValue = "切换中…";
    outputDetail = undefined;
    outputTone = "idle";
  }
  const audioUnsupported = !!monitor && !monitor.audio;
  const audioEffective = current === "running" && state.audio && !!input?.audio && !!monitor?.audio
    && (!state.audioState || state.audioState === "running");
  const audioLabel = current === "starting" ? "透传开启后生效" : current === "stopping" ? "已关闭"
    : !state.enabled ? "透传开启后生效" : audioUnsupported ? "显示器不支持音频"
    : !state.audio ? "已关闭" : !input?.audio ? "输入无声音"
    : ["error", "unavailable"].includes(state.audioState || "") ? "声音暂不可用"
    : state.audioState && state.audioState !== "running" ? "正在连接声音…" : "输出中";

  return <section aria-label="透传"><div className="wifi-card passthrough-card">
    <SwitchRow title="透传" description="把 HDMI IN 的画面原样送到本地显示器，远程 KVM 照常使用。"
      label={labels[current]} checked={enabled} disabled={locked} pending={transitioning}
      onToggle={() => void change({ enabled: !state.enabled })} />
    <div className="passthrough-body">
      {state.supported && <dl className="edid-facts passthrough-facts">
        <Fact label="输入" value={input ? mode(input.width, input.height, input.refreshHz) : "无信号"}
          detail={input ? `${input.hdr} · ${input.colorFormat}` : undefined} tone={input ? "good" : "idle"} />
        <Fact label="显示器" value={monitor ? monitor.name || "未知型号" : "未连接"}
          detail={monitor ? `最高 ${mode(monitor.maxWidth, monitor.maxHeight, monitor.maxRefreshHz)}${monitor.hdr ? " · HDR" : ""}` : undefined}
          tone={monitor ? "good" : "idle"} />
        <Fact label="输出" value={outputValue} detail={outputDetail} tone={outputTone} />
      </dl>}
      <p className="muted passthrough-description">{description}</p>
      {error && <p className="edid-error" role="alert">刷新失败：{error}，显示的是上次读取的状态。</p>}
    </div>
    {state.supported && <SwitchRow title="声音" description="把 HDMI IN 的声音送到显示器扬声器。"
      label={audioLabel} checked={state.audio} inactive={!audioEffective} disabled={locked || (state.enabled && audioUnsupported)}
      onToggle={() => void change({ audio: !state.audio })} />}
  </div></section>;
}

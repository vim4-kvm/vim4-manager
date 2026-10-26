import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { request, type PassthroughState } from "@/api";
import { DeviceConnections } from "@/components/DeviceConnections";
import { Fact, FactGrid } from "@/components/FactGrid";
import { InlineError } from "@/components/InlineError";
import { Collapse, FadeIn } from "@/components/Motion";
import { SettingRow } from "@/components/SettingRow";
import { SettingsCard } from "@/components/SettingsCard";
import { PageHeading } from "@/components/PageHeading";
import { Notice } from "@/components/Notice";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useActionStore } from "@/stores/action";
import { usePassthroughStore } from "@/stores/passthrough";
import { useStatusStore } from "@/stores/status";

const labels: Record<PassthroughState["state"], string> = {
  unsupported: "当前内核不支持",
  off: "已关闭",
  starting: "正在开启…",
  stopping: "正在关闭…",
  running: "透传中",
  "no-signal": "等待输入信号",
  "no-monitor": "未连接显示器",
  protected: "输入受版权保护",
  "unsupported-format": "暂不支持此输入格式",
  "video-error": "输入信号异常",
};

const descriptions = {
  unsupported: <>当前内核没有透传功能，可在「<a href="#/updates" className="text-primary underline-offset-4 hover:underline">更新 → 内核</a>」中切换到支持透传的版本。</>,
  off: "开启后显示器显示被控电脑的画面；关闭时显示系统控制台。",
  running: "远程 KVM 不受影响。被控电脑切换分辨率时，显示器会短暂黑屏后跟随。",
  "no-signal": "HDMI IN 没有信号，显示器保持黑屏，信号恢复后自动继续。",
  "no-monitor": "接上显示器后自动开始透传。",
  protected: "被控电脑正在播放受 HDCP 保护的内容，显示器保持黑屏。",
  "unsupported-format": "此输入格式无法透传，请在信号源中选择 HDR10、HLG 或 SDR。",
  "video-error": "请检查 HDMI 输入线或信号源设置。",
};

function refreshLabel(hz: number) {
  return `${Number(hz.toFixed(2))}Hz`;
}

function mode(width: number, height: number, hz: number) {
  return `${width}×${height} ${refreshLabel(hz)}`;
}

/** Same shape as the loaded card; the reading text stays for screen readers. */
function PassthroughSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <span className="sr-only">正在读取透传状态…</span>
      <div className="flex items-center justify-between gap-6">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-5 w-32" />
      </div>
      <div className="grid grid-cols-1 gap-x-8 gap-y-4 @md:grid-cols-3">
        {[0, 1, 2].map((i) => <div key={i} className="flex flex-col gap-1.5"><Skeleton className="h-3 w-10" /><Skeleton className="h-5 w-32" /></div>)}
      </div>
      <Skeleton className="h-4 w-3/4" />
    </div>
  );
}

export function PassthroughPanel() {
  const status = useStatusStore((s) => s.status);
  const busy = useActionStore((s) => !!s.busy);
  const run = useActionStore((s) => s.run);
  const stale = useStatusStore((s) => s.stale);
  const onState = usePassthroughStore((s) => s.setState);
  const [state, setState] = useState<PassthroughState>();
  const [error, setError] = useState<string>();
  const [readStale, setReadStale] = useState(true);
  const [pending, setPending] = useState<"starting" | "stopping" | "audio" | "hdr">();
  const [hdrTarget, setHdrTarget] = useState(true);
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
    if (next.state !== "starting" && next.state !== "stopping") setDescription(next.reason || descriptions[next.state]);
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

  async function change(body: { enabled?: boolean; audio?: boolean; hdr?: boolean }) {
    if (actionPending.current) return;
    actionPending.current = true;
    const transition = body.hdr !== undefined ? "hdr" : body.enabled === undefined ? "audio" : body.enabled ? "starting" : "stopping";
    if (body.hdr !== undefined) setHdrTarget(body.hdr);
    setPending(transition);
    const verb = transition === "hdr" ? "保存 HDR 设置" : body.enabled === undefined ? "保存声音设置" : body.enabled ? "开启透传" : "关闭透传";
    await run(transition === "hdr" ? "正在切换 HDR…" : transition === "audio" ? "正在保存声音设置…" : labels[transition], async () => {
      try {
        const next = await request<PassthroughState>("/api/passthrough", body, AbortSignal.timeout(20000));
        if (mounted.current) accept(next);
      } catch (e) {
        let reason = e instanceof Error ? e.message : String(e);
        if (transition === "hdr" && !/^[\u3400-\u9fff\s，。；、！…（）·]+$/.test(reason.replaceAll("HDR", ""))) {
          reason = "HDR 设置未能应用，请稍后重试";
        }
        throw new Error(`${verb}失败：${reason}`);
      }
    }, transition === "hdr" ? body.hdr ? "HDR 透传已开启" : "已改为 HDR 转 SDR 输出"
      : body.enabled === undefined ? "声音设置已保存" : body.enabled ? "透传已开启" : "透传已关闭");
    // A failed or lost response may still have changed the kernel. Keep the
    // old facts and lock controls until a fresh GET establishes actual state.
    if (mounted.current) {
      setReadStale(true);
      setPending(undefined);
    }
    actionPending.current = false;
  }

  if (!state) return <><PageHeading page="output" /><SettingsCard label="透传">
    {error ? <InlineError>读取失败：{error}</InlineError> : <PassthroughSkeleton />}
  </SettingsCard></>;

  const current = pending === "starting" || pending === "stopping" ? pending : state.state;
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
    if (output.hdrToSdr) {
      const mapping = monitor && !monitor.hdr ? "HDR 已转为 SDR · 显示器不支持 HDR" : "HDR 已转为 SDR";
      outputDetail = output.scaled ? `${outputDetail} · ${mapping}` : mapping;
    } else if (input && ["HDR10", "HLG"].includes(input.hdr)) {
      outputDetail = `${input.hdr} · BT.2020 · ${output.colorFormat.replace(/ limited$/, "")}`;
    }
  }
  if (transitioning) {
    outputValue = "切换中…";
    outputDetail = undefined;
    outputTone = "idle";
  }
  const audioUnsupported = !!monitor && !monitor.audio;
  const hdr = state.hdr ?? true;
  const hdrUnsupported = !!monitor && !monitor.hdr;
  const hdrLabel = pending === "hdr" ? "正在切换…"
    : current === "starting" ? "透传开启后生效" : current === "stopping" ? "已关闭"
    : !state.enabled ? "透传开启后生效" : hdrUnsupported ? "显示器不支持 HDR"
    : !input ? "等待输入信号" : input.hdr === "SDR" ? "输入为 SDR"
    : hdr && current === "running" && output && !output.hdrToSdr ? "HDR 输出中"
    : !hdr && current === "running" && output?.hdrToSdr ? "已转为 SDR" : "正在应用…";
  const hdrInactive = pending !== "hdr" && (transitioning || !state.enabled || hdrUnsupported || !input || input.hdr === "SDR");
  const audioEffective = state.enabled && state.audio && !!input?.audio && !!monitor?.audio
    && (state.audioState ? state.audioState === "running" : current === "running");
  const audioLabel = current === "starting" ? "透传开启后生效" : current === "stopping" ? "已关闭"
    : !state.enabled ? "透传开启后生效" : audioUnsupported ? "显示器不支持音频"
    : !state.audio ? "已关闭" : !input?.audio ? "输入无声音"
    : ["error", "unavailable"].includes(state.audioState || "") ? "声音暂不可用"
    : state.audioState && state.audioState !== "running" ? "正在连接声音…" : "输出中";

  return <>
    <PageHeading page="output" />
    <section role="region" aria-label="透传" className="flex min-w-0 flex-col gap-5">
    <SettingsCard title="信号路径" description="查看 HDMI、USB-C 与网络连接，点击接口查看详情。">
    <FadeIn><SettingRow title="透传" description="把 HDMI IN 的画面原样送到本地显示器，远程 KVM 照常使用。"
      status={labels[current]} pending={transitioning}
      control={<Switch aria-label="透传" checked={enabled} disabled={locked}
        onCheckedChange={() => void change({ enabled: !state.enabled })} />} /></FadeIn>
    <FadeIn><DeviceConnections status={status} passthrough={{ ...state, state: current }} stale={stale || readStale} /></FadeIn>
    <FadeIn className="flex flex-col gap-4" data-passthrough-body>
      <Collapse open={state.supported}>
        <FactGrid>
          <Fact label="输入" value={input ? mode(input.width, input.height, input.refreshHz) : "无信号"}
            detail={input ? `${input.hdr} · ${input.colorFormat}` : undefined} tone={input ? "good" : "idle"} />
          <Fact label="显示器" value={monitor ? monitor.name || "未知型号" : "未连接"}
            detail={monitor ? `最高 ${mode(monitor.maxWidth, monitor.maxHeight, monitor.maxRefreshHz)}${monitor.hdr ? " · HDR" : ""}` : undefined}
            tone={monitor ? "good" : "idle"} />
          <Fact label="输出" value={outputValue} detail={outputDetail} tone={outputTone} />
        </FactGrid>
      </Collapse>
      <p data-description className="text-sm text-pretty text-muted-foreground">{description}</p>
      <Collapse open={!!error}>
        <InlineError>刷新失败：{error}，显示的是上次读取的状态。</InlineError>
      </Collapse>
    </FadeIn>
    </SettingsCard>
    {state.supported && <div className="grid items-start gap-5 lg:grid-cols-2">
    <SettingsCard title="输出设置">
    {state.supported && <FadeIn><SettingRow title="HDR" description="开启时把 HDR 画面原样送到显示器，关闭时转为 SDR 显示。远程 KVM 不受影响。"
      status={hdrLabel} inactive={hdrInactive} pending={pending === "hdr"}
      control={<Switch aria-label="HDR" checked={pending === "hdr" ? hdrTarget : hdr}
        disabled={locked || (state.enabled && hdrUnsupported)} onCheckedChange={() => void change({ hdr: !hdr })} />} /></FadeIn>}
    {state.supported && <FadeIn><SettingRow title="声音" description="把 HDMI IN 的声音送到显示器扬声器。"
      status={audioLabel} inactive={!audioEffective}
      control={<Switch aria-label="声音" checked={state.audio}
        disabled={locked || (state.enabled && audioUnsupported)} onCheckedChange={() => void change({ audio: !state.audio })} />} /></FadeIn>}
      <Notice>信号源切换分辨率时，本地显示器可能短暂黑屏。</Notice>
    </SettingsCard>
    <SettingsCard title="显示器信息">
      <dl className="space-y-4 text-sm">{[
        ["型号", monitor?.name || (monitor ? "未知型号" : "未连接")],
        ["最大分辨率", monitor ? `${monitor.maxWidth} × ${monitor.maxHeight}` : "—"],
        ["最高刷新率", monitor ? refreshLabel(monitor.maxRefreshHz) : "—"],
        ["HDR", monitor ? monitor.hdr ? "支持" : "不支持" : "—"],
        ["音频", monitor ? monitor.audio ? "支持" : "不支持" : "—"],
      ].map(([label, value], i) => <div className={`flex justify-between gap-6 ${i ? "border-t pt-4" : ""}`} key={label}><dt className="shrink-0 text-muted-foreground">{label}</dt><dd className="min-w-0 break-words text-right font-medium">{value}</dd></div>)}</dl>
    </SettingsCard>
    </div>}
    {state.supported && <SettingsCard title="当前信号格式"><FactGrid cols={2}>
      <Fact label="输入格式" value={input ? `${input.colorFormat} · ${input.hdr}` : "无信号"} />
      <Fact label="输出格式" value={current === "running" && output ? `${output.colorFormat} · ${output.hdrToSdr ? "SDR" : input?.hdr || "未知"}` : "—"} />
    </FactGrid></SettingsCard>}
    </section>
  </>;
}

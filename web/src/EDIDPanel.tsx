import { useEffect, useState } from "react";
import { request } from "./api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Fact, FactGrid } from "@/components/FactGrid";
import { InlineError } from "@/components/InlineError";
import { Collapse, FadeIn } from "@/components/Motion";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingRow } from "@/components/SettingRow";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useActionStore } from "@/stores/action";

interface EDIDState {
  presets: { id: string; name: string; description: string }[];
  selected: string;
  savedName: string;
  active: string;
  activeKnown: boolean;
  jetkvmSynced: boolean;
}

export function EDIDPanel() {
  const busy = useActionStore((s) => !!s.busy);
  const run = useActionStore((s) => s.run);
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
      {error ? <InlineError>读取失败：{error}</InlineError> : <PanelSkeleton label="正在读取 EDID…" />}
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

  return <FadeIn className="flex flex-col gap-5">
    <FactGrid>
      <Fact label="已保存" value={name(state.selected) ?? (state.savedName || "自定义 EDID")}
        tone={state.selected ? "good" : "warning"} />
      <Fact label="本次开机加载" value={state.activeKnown ? name(state.active) ?? "自定义 EDID" : "未记录"}
        tone={!state.activeKnown ? "idle" : state.active === state.selected ? "good" : "warning"} />
      <Fact label="JetKVM" value={state.jetkvmSynced ? "已同步" : "配置不同"} tone={state.jetkvmSynced ? "good" : "warning"} />
    </FactGrid>
    <Collapse open={!!error}><InlineError>刷新失败：{error}，显示的是上次读取的状态。</InlineError></Collapse>
    <div className="flex flex-col gap-2" role="radiogroup" aria-label="EDID 预设">
      {state.presets.map(p => <label key={p.id}
        className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-3 has-focus-visible:ring-ring/50">
        <input type="radio" name="edid" value={p.id} checked={p.id === selected} disabled={busy}
          className="mt-1 shrink-0 accent-primary" onChange={() => { setChoice(p.id); setConfirming(false); }} />
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2"><strong className="font-medium">{p.name}</strong>
            {p.id === state.selected && <Badge variant="secondary">已保存</Badge>}
            {state.activeKnown && p.id === state.active && <Badge variant="outline">已加载</Badge>}
          </span>
          <span className="text-sm text-muted-foreground">{p.description}</span>
        </span>
      </label>)}
    </div>
    <SettingRow title="EDID" description={inSync ? "所选预设已保存并加载。" : !state.jetkvmSynced && selected === state.selected
      ? "重新应用可同步 JetKVM 配置。" : "应用后保存，重启仍然有效。"}
      control={<>
        {choice !== undefined && choice !== state.selected && <Button variant="outline" disabled={busy} onClick={() => setChoice(undefined)}>撤销</Button>}
        <Button disabled={busy || !target || inSync} onClick={() => setConfirming(true)}>应用预设</Button>
      </>} />
    <ConfirmDialog open={confirming} onOpenChange={setConfirming} title="确认切换 EDID"
      description="被控电脑会重新识别显示器，可能短暂黑屏或改变桌面布局；JetKVM 运行中会重启。"
      confirm="切换" onConfirm={() => void apply()} />
  </FadeIn>;
}

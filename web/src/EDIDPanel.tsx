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
import { useLocale, useT } from "@/i18n";

interface EDIDState {
  presets: { id: string; name: string; description: string }[];
  selected: string;
  savedName: string;
  active: string;
  activeKnown: boolean;
  jetkvmSynced: boolean;
}

export function EDIDPanel() {
  const t = useT();
  const locale = useLocale();
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
  }, [busy, locale]);

  if (!state) {
    return <div>
      {error ? <InlineError>{t("edid.loadFailed", { reason: error })}</InlineError> : <PanelSkeleton label={t("edid.loading")} />}
    </div>;
  }

  const name = (id: string) => state.presets.find(p => p.id === id)?.name;
  const selected = choice ?? state.selected;
  const target = state.presets.find(p => p.id === selected);
  // Applying the saved preset again still loads it and synchronizes JetKVM.
  const inSync = selected === state.selected && state.activeKnown && state.active === state.selected && state.jetkvmSynced;
  const apply = async () => {
    setConfirming(false);
    if (await run(t("edid.applying", { name: target!.name }), () => request("/api/edid", { id: selected }),
      t("edid.applied", { name: target!.name }))) setChoice(undefined);
  };

  return <FadeIn className="flex flex-col gap-5">
    <Collapse open={!!error}><InlineError>{t("edid.refreshFailed", { reason: error ?? "" })}</InlineError></Collapse>
    <div className="flex flex-col gap-2" role="radiogroup" aria-label={t("edid.presets")}>
      {state.presets.map(p => <label key={p.id}
        className="flex cursor-pointer items-start gap-3 rounded-lg border p-4 has-checked:border-chart-1 has-checked:bg-chart-1/5 has-focus-visible:ring-3 has-focus-visible:ring-ring/50">
        <input type="radio" name="edid" value={p.id} checked={p.id === selected} disabled={busy}
          className="mt-1 size-4 shrink-0 accent-chart-1" onChange={() => { setChoice(p.id); setConfirming(false); }} />
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2"><strong className="font-medium">{p.name}</strong>
            {p.id === state.selected && <Badge variant="secondary">{t("edid.saved")}</Badge>}
            {state.activeKnown && p.id === state.active && <Badge variant="outline">{t("edid.loaded")}</Badge>}
          </span>
          <span className="text-sm text-muted-foreground">{p.description}</span>
        </span>
      </label>)}
    </div>
    <FactGrid>
      <Fact label={t("edid.saved")} value={name(state.selected) ?? (state.savedName || t("edid.custom"))}
        tone={state.selected ? "good" : "warning"} />
      <Fact label={t("edid.loadedThisBoot")} value={state.activeKnown ? name(state.active) ?? t("edid.custom") : t("edid.notRecorded")}
        tone={!state.activeKnown ? "idle" : state.active === state.selected ? "good" : "warning"} />
      <Fact label="JetKVM" value={state.jetkvmSynced ? t("edid.synced") : t("edid.different")} tone={state.jetkvmSynced ? "good" : "warning"} />
    </FactGrid>
    <SettingRow title="EDID" description={inSync ? t("edid.inSync") : !state.jetkvmSynced && selected === state.selected
      ? t("edid.syncHelp") : t("edid.persistHelp")}
      control={<>
        {choice !== undefined && choice !== state.selected && <Button variant="outline" disabled={busy} onClick={() => setChoice(undefined)}>{t("cooling.undo")}</Button>}
        <Button disabled={busy || !target || inSync} onClick={() => setConfirming(true)}>{t("edid.apply")}</Button>
      </>} />
    <ConfirmDialog open={confirming} onOpenChange={setConfirming} title={t("edid.confirm")}
      description={t("edid.confirmHelp")}
      confirm={t("edid.change")} onConfirm={() => void apply()} />
  </FadeIn>;
}

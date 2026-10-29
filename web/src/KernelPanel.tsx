import { FadeIn } from "@/components/Motion";
import { AnimatedList } from "@/components/AnimatedList";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { InlineError } from "@/components/InlineError";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingRow } from "@/components/SettingRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Cpu } from "lucide-react";
import { useActionStore } from "@/stores/action";
import { useEffect, useState } from "react";
import { request } from "./api";
import { Notice } from "@/components/Notice";
import { t, useLocale } from "@/i18n";

interface Kernel {
  id: string;
  name: string;
  release: string;
  selected: boolean;
  available: boolean;
  error: string;
}
interface KernelState { running: string; kernels: Kernel[] }

export function KernelPanel() {
  const locale = useLocale();
  const busy = useActionStore((s) => !!s.busy);
  const run = useActionStore((s) => s.run);
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
  }, [busy, rebooting, locale]);

  const apply = async () => {
    if (!choice) return;
    const ok = await run(t("kernel.switchingKernel"), () => request("/api/kernel", {
      id: choice.id, reboot: true,
    }), t("kernel.defaultKernelSavedTheDeviceWill"));
    if (ok) { setRebooting(true); setChoice(undefined); }
  };

  return <div className="flex flex-col gap-4">
    <p className="text-sm text-muted-foreground">{t("kernel.runningSummary", { release: state?.running ?? t("common.loading") })}</p>
    {error && <InlineError>{error}</InlineError>}
    {!state && !error && <PanelSkeleton label={t("common.loading")} />}
    {state && state.kernels.length === 0 && <EmptyState icon={Cpu}>{t("kernel.noSwitchableKernelsRegisteredYet")}</EmptyState>}
    {state && <FadeIn><AnimatedList items={state.kernels} getKey={(kernel) => kernel.id} className="grid gap-4 lg:grid-cols-2" itemClassName="min-w-0">{kernel => <div className={`h-full rounded-lg border p-5 ${kernel.release === state.running ? "border-chart-1/30 bg-chart-1/4" : "bg-muted/20"}`}>
      <SettingRow title={kernel.name} badges={<>
        {kernel.release === "7.3.0-vim4kvm-uhd1+" && <Badge variant="secondary">{t("kernel.stable")}</Badge>}
        {kernel.selected && <Badge variant="secondary">{t("kernel.defaultBoot")}</Badge>}
        {kernel.release === state.running && <Badge variant="outline" className="border-success/20 bg-success/10 text-success-foreground">{t("kernel.running")}</Badge>}
      </>} description={<span className="font-mono break-all">{kernel.release}</span>}
        status={kernel.error || (kernel.release === state.running ? t("kernel.running226") : kernel.available ? t("kernel.available") : t("kernel.unavailable"))}
        control={<Button variant="outline" disabled={busy || rebooting || !kernel.available || !!choice}
          onClick={() => setChoice(kernel)}>{kernel.release === state.running ? t("kernel.restartThisKernel") : t("kernel.switchAndRestart")}</Button>} />
    </div>}</AnimatedList></FadeIn>}
    <Notice>{t("kernel.switchingKernelsRestartsTheBoardAnd")}</Notice>
    {choice && <ConfirmDialog open title={t("kernel.switchTo", { p0: String(choice.name) })} confirm={t("kernel.restart")} busy={busy}
      description={t("kernel.restartHelp", { name: choice.name })}
      onOpenChange={(open) => { if (!open) setChoice(undefined); }} closeOnConfirm={false} onConfirm={() => void apply()} />}
    {rebooting && <p role="status" className="text-sm text-muted-foreground">{t("kernel.theDeviceIsRestartingRefreshThis")}</p>}
  </div>;
}

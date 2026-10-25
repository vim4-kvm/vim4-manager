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
  }, [busy, rebooting]);

  const apply = async () => {
    if (!choice) return;
    const ok = await run("切换内核", () => request("/api/kernel", {
      id: choice.id, reboot: true,
    }), "已保存默认内核，设备即将重启");
    if (ok) { setRebooting(true); setChoice(undefined); }
  };

  return <div className="flex flex-col gap-4">
    <p className="text-sm text-muted-foreground">当前运行 <span className="font-mono">{state?.running ?? "正在读取…"}</span> · 同一应用的账户、设置和镜像共用</p>
    {error && <InlineError>{error}</InlineError>}
    {!state && !error && <PanelSkeleton label="正在读取…" />}
    {state && state.kernels.length === 0 && <EmptyState icon={Cpu}>尚未登记可切换的内核。</EmptyState>}
    {state && <FadeIn><AnimatedList items={state.kernels} getKey={(kernel) => kernel.id} className="flex flex-col divide-y" itemClassName="py-4 first:pt-0 last:pb-0">{kernel => <div>
      <SettingRow title={kernel.name} badges={<>
        {kernel.release === "7.3.0-vim4kvm-uhd1+" && <Badge variant="secondary">正式版</Badge>}
        {kernel.selected && <Badge variant="secondary">默认启动</Badge>}
      </>} description={<span className="font-mono break-all">{kernel.release}</span>}
        status={kernel.error || (kernel.release === state.running ? "正在运行" : kernel.available ? "可切换" : "不可用")}
        control={<Button variant="outline" disabled={busy || rebooting || !kernel.available || !!choice}
          onClick={() => setChoice(kernel)}>{kernel.release === state.running ? "重启此内核" : "切换并重启"}</Button>} />
    </div>}</AnimatedList></FadeIn>}
    {choice && <ConfirmDialog open title={`切换到 ${choice.name}`} confirm="确认重启" busy={busy}
      description={<>将默认启动设为 {choice.name} 并重启，当前连接会断开。请先安全弹出虚拟磁盘；启动失败时需通过串口或 OOWOW 恢复。</>}
      onOpenChange={(open) => { if (!open) setChoice(undefined); }} closeOnConfirm={false} onConfirm={() => void apply()} />}
    {rebooting && <p role="status" className="text-sm text-muted-foreground">设备正在重启，启动完成后请刷新此页面。</p>}
  </div>;
}

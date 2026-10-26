import { TailscalePanel } from "@/TailscalePanel";
import { WifiControl } from "@/WifiControl";
import { Network as NetworkIcon } from "lucide-react";
import { PageHeading } from "@/components/PageHeading";
import { SettingsCard } from "@/components/SettingsCard";
import { Fact, FactGrid } from "@/components/FactGrid";
import { StatusLabel } from "@/components/StatusDot";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { useStatusStore } from "@/stores/status";

export function Network() {
  const status = useStatusStore((s) => s.status);
  const stale = useStatusStore((s) => s.stale);
  const links = status?.system.links.filter((link) => !link.wireless && /^e(n|th)/.test(link.name));
  return <>
    <PageHeading page="network" />
    <SettingsCard label="有线网络">
      {!status ? <PanelSkeleton rows={1} /> : links?.length ? <div className="space-y-5">{links.map((link) => <div key={link.name} className="flex flex-wrap items-center gap-6">
        <div className="flex flex-1 basis-60 items-center gap-4"><div className="rounded-xl bg-muted p-3"><NetworkIcon className="size-6" aria-hidden="true" /></div><div className="space-y-1.5"><div className="flex flex-wrap items-center gap-3"><h2 className="text-base font-semibold">有线网络</h2><StatusLabel tone={stale ? "warning" : link.up ? "good" : "idle"}>{stale ? "状态未知" : link.up ? "已连接" : "未连接"}</StatusLabel></div><p className="text-xs text-muted-foreground">通过有线网络访问本地网络。</p></div></div>
        <FactGrid className="flex-1 basis-96"><Fact label="接口" value={link.name} /><Fact label="IP 地址" value={link.addrs?.join(" · ") || "未分配"} /><Fact label="链路速度" value={link.speedMbps ? link.speedMbps >= 1000 ? `${link.speedMbps / 1000} Gbps` : `${link.speedMbps} Mbps` : "未知"} /></FactGrid>
      </div>)}</div> : <p className="text-sm text-muted-foreground">未检测到有线网卡。</p>}
    </SettingsCard>
    <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2"><WifiControl /><TailscalePanel /></div>
  </>;
}

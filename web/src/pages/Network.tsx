import { useT } from "@/i18n";
import { number } from "@/i18n/format";
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
  const t = useT();
  const status = useStatusStore((s) => s.status);
  const stale = useStatusStore((s) => s.stale);
  const links = status?.system.links.filter((link) => !link.wireless && /^e(n|th)/.test(link.name));
  return <>
    <PageHeading page="network" />
    <SettingsCard label={t("network.ethernet")}>
      {!status ? <PanelSkeleton rows={1} /> : links?.length ? <div className="space-y-5">{links.map((link) => <div key={link.name} className="flex flex-wrap items-center gap-6">
        <div className="flex flex-1 basis-60 items-center gap-4"><div className="rounded-xl bg-muted p-3"><NetworkIcon className="size-6" aria-hidden="true" /></div><div className="space-y-1.5"><div className="flex flex-wrap items-center gap-3"><h2 className="text-base font-semibold">{t("network.ethernet")}</h2><StatusLabel tone={stale ? "warning" : link.up ? "good" : "idle"}>{stale ? t("network.unknown") : link.up ? t("network.connected") : t("network.disconnected")}</StatusLabel></div><p className="text-xs text-muted-foreground">{t("network.ethernetHelp")}</p></div></div>
        <FactGrid cols={2} className="flex-1 basis-96"><Fact label={t("network.interface")} value={link.name} /><Fact label={t("network.linkSpeed")} value={link.speedMbps ? link.speedMbps >= 1000 ? `${number(link.speedMbps / 1000)} Gbps` : `${number(link.speedMbps)} Mbps` : t("common.unknown")} />
          {/* One address per line: IPv6 addresses are too long to share a line or break mid-group. */}
          <Fact label={t("network.ip")} className="@md:col-span-2" valueKey={link.addrs?.join(" ") || t("network.unassigned")} value={link.addrs?.length
            ? <span className="flex flex-col gap-1 font-mono text-xs font-normal">{[...link.addrs].sort((a, b) => Number(a.includes(":")) - Number(b.includes(":"))).map((addr) => <span key={addr}>{addr}</span>)}</span>
            : t("network.unassigned")} /></FactGrid>
      </div>)}</div> : <p className="text-sm text-muted-foreground">{t("network.noEthernet")}</p>}
    </SettingsCard>
    <WifiControl /><TailscalePanel />
  </>;
}

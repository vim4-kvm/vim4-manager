import { hdrLabel } from "@/lib/units";
import { number } from "@/i18n/format";
import { t, useLocale } from "@/i18n";
import { previewHDRCurve, setHDRCurve, setHDRMapping } from "@/api";
import { EDIDPanel } from "@/EDIDPanel";
import { HDRPanel } from "@/HDRPanel";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingsCard } from "@/components/SettingsCard";
import { PageHeading } from "@/components/PageHeading";
import { StatusLabel } from "@/components/StatusDot";
import { SettingRow } from "@/components/SettingRow";
import { Switch } from "@/components/ui/switch";
import { useActionStore } from "@/stores/action";
import { useStatusStore } from "@/stores/status";

export function Video() {
 useLocale();
  const hw = useStatusStore((s) => s.status?.hardware);
  const stale = useStatusStore((s) => s.stale);
  const busy = useActionStore((s) => !!s.busy);
  const run = useActionStore((s) => s.run);
  const mapping = hw?.hdrToSdr ?? true;
  return <>
    <PageHeading page="video" />
    {hw && <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border bg-card px-5 py-5 text-sm">
      <StatusLabel tone={stale ? "warning" : hw.hdmi.signal ? "good" : "idle"}><strong>{stale ? t("overview.connectionLost") : hw.hdmi.signal ? t("video.inputConnected") : t("video.noInputSignal")}</strong></StatusLabel>
      {hw.hdmi.signal && <>
        <span className="font-semibold tabular-nums">{hw.hdmi.width}×{hw.hdmi.height}</span>
        <span className="text-muted-foreground tabular-nums">{hw.hdmi.refreshHz ? `${number(hw.hdmi.refreshHz, {maximumFractionDigits:2})} Hz` : t("video.refreshRateUnknown")}</span>
        <span className="text-muted-foreground">{hw.hdmi.colorSpace || t("video.colorFormatUnknown")}{hw.hdmi.depth ? ` · ${hw.hdmi.depth} bit` : ""}</span>
        <span className="text-muted-foreground">{hdrLabel(hw.hdmi.hdr) || t("video.hdrStatusUnknown")}</span>
        <span className="text-muted-foreground">{hw.hdmi.audio ? t("video.audioDetected") : t("video.noAudio")}</span>
      </>}
    </div>}
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
    <SettingsCard title={t("video.displayCapabilitiesEdid")} description={t("video.theTargetComputerUsesEdidTo")}><EDIDPanel /></SettingsCard>
    <SettingsCard title={t("video.hdrToSdr")} description={t("video.defaultForRemoteVideoUuCan")}>
      {hw && <SettingRow title={t("video.enableHdrToSdr")}
        description={t("video.whenOffAllFourKvmInterfaces")}
        status={!mapping && !hw.hdrRemoteAvailable ? t("video.thisEnvironmentContinuesToUseSdr") : !hw.hdmi.signal ? t("connections.waitingForInput") : hw.hdmi.hdr === "SDR" ? t("video.sdrInput") : mapping ? t("video.convertToSdrByDefault") : t("video.keepHdrByDefault")}
        inactive={!hw.hdmi.signal || hw.hdmi.hdr === "SDR"}
        control={<Switch aria-label={t("video.enableHdrToSdr")} checked={mapping} disabled={busy || stale}
          onCheckedChange={(enabled) => void run(t("video.savingHdrSettings"), () => setHDRMapping(enabled), enabled ? t("video.hdrToSdrEnabled") : t("video.hdrToSdrDisabledByDefault"))} />} />}
      {hw ? <HDRPanel curve={hw.hdrCurve} hdr={hw.hdmi.hdr} mappingEnabled={mapping} busy={busy || !mapping} onPreview={previewHDRCurve}
        onSave={(curve) => void run(t("video.savingHdrMapping"), () => setHDRCurve(curve), t("video.hdrMappingSavedSdrWhiteNits", { p0: String(curve.white), p1: String(curve.peak) }))} />
        : <PanelSkeleton />}
    </SettingsCard>
    </div>
  </>;
}

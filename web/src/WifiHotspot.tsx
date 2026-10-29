import { useT } from "@/i18n";
import { Checkbox } from "@/components/ui/checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented, SegmentedOption } from "@/components/Segmented";
import { Wifi } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { AnimatedList } from "@/components/AnimatedList";
import { Fact, FactGrid } from "@/components/FactGrid";
import { StatusDot } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Eye, EyeOff, QrCode } from "lucide-react";
import { DetailsDialog } from "@/components/DetailsDialog";
import { useState } from "react";
import { wifiWrite, type Hotspot } from "./api";
import { CopyButton } from "@/components/CopyButton";
import { IconButton } from "@/components/IconButton";
import { PasswordInput } from "@/components/PasswordInput";
import { QRCode, wifiQRText } from "@/components/QRCode";

const HOTSPOT_PSK = /^[\x20-\x7e]{8,63}$/;

export function WifiHotspot({
  hotspot,
  locked,
  act,
}: {
  hotspot: Hotspot;
  locked: boolean;
  act: (label: string, run: () => Promise<unknown>) => Promise<boolean>;
}) {
  const t = useT();
  const [reveal, setReveal] = useState(false);
  const [editing, setEditing] = useState(false);
  const [ssid, setSSID] = useState("");
  const [password, setPassword] = useState("");
  const [channel, setChannel] = useState(0);
  const [sharing, setSharing] = useState(false);

  const ip = hotspot.address.split("/")[0];
  const ssidBytes = new TextEncoder().encode(ssid).length;
  const ssidValid = ssidBytes >= 1 && ssidBytes <= 32 && !/[\x00-\x1f\x7f]/.test(ssid);
  const passwordValid = password === "" || HOTSPOT_PSK.test(password);

  function edit() {
    setSSID(hotspot.ssid);
    setPassword("");
    setChannel(hotspot.channel);
    setEditing(true);
  }

  async function save() {
    const ok = await act(t("hotspot.applying"), () =>
      wifiWrite("/hotspot", { ssid, password, channel, autostart: hotspot.autostart }),
    );
    if (ok) setEditing(false);
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <FactGrid cols={1}>
        <Fact label={t("hotspot.ssid")} value={<div className="flex min-w-0 flex-col gap-2 text-sm font-normal">
            <span className="flex min-w-0 flex-wrap items-center gap-2 [overflow-wrap:anywhere]">
              <StatusDot tone={hotspot.active ? "good" : "idle"} />
              <strong>{hotspot.ssid}</strong>
              <span className="text-muted-foreground">{hotspot.active ? t("hotspot.broadcasting") : t("hotspot.notStarted")}</span>
              {hotspot.active && <IconButton icon={QrCode} label={t("hotspot.scanJoin")} onClick={() => setSharing(true)} />}
            </span>
          </div>} />
        <Fact label={t("login.password")} value={<div className="flex min-w-0 flex-col gap-2 text-sm font-normal">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <code className="font-mono break-all">{reveal ? hotspot.password : "•".repeat(Math.max(8, hotspot.password.length))}</code>
              <IconButton icon={reveal ? EyeOff : Eye} label={reveal ? t("login.hidePassword") : t("login.showPassword")} onClick={() => setReveal(!reveal)} />
              <CopyButton text={hotspot.password} label={t("hotspot.password")} />
            </span>
          </div>} />
        {hotspot.active && ip && (
          <Fact label={t("hotspot.address")} value={<div className="flex min-w-0 flex-col gap-2 text-sm font-normal">
              <ul className="flex flex-col gap-2 [&_li]:flex [&_li]:flex-wrap [&_li]:items-center [&_li]:gap-x-4 [&_li]:gap-y-1">
                {[
                  { label: t("nav.manager"), url: `http://${ip}` },
                  { label: t("nav.apps"), url: `http://${ip}:8080` },
                ].map(({ label, url }) => (
                  <li key={url}>
                    <span className="min-w-16 text-xs text-muted-foreground">{label}</span>
                    <span className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
                      <span className="font-mono break-all">{url}</span>
                      <CopyButton text={url} label={t("hotspot.addressLabel", { label })} />
                    </span>
                  </li>
                ))}
              </ul>
              <span className="text-muted-foreground">{t("hotspot.addressesHelp")}</span>
            </div>} />
        )}
        <Fact label={t("hotspot.startup")} value={<div className="flex min-w-0 flex-col gap-2 text-sm font-normal">
            <label className="flex items-start gap-2 text-sm">
              <Checkbox className="mt-0.5"
                aria-label={t("hotspot.autoStart")}
                checked={hotspot.autostart}
                disabled={locked}
                onCheckedChange={(value) =>
                  void act(t("common.saving"), () =>
                    wifiWrite("/hotspot", {
                      ssid: hotspot.ssid,
                      password: "",
                      channel: hotspot.channel,
                      autostart: value === true,
                    }),
                  )
                }
              />
              {t("hotspot.autoStart")}</label>
          </div>} />
      </FactGrid>

      {editing ? (
        <form
          className="grid min-w-0 gap-4 @lg:grid-cols-2 [&_select]:h-8 [&_select]:rounded-md [&_select]:border [&_select]:bg-card [&_select]:px-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (ssidValid && passwordValid && !locked) void save();
          }}
        >
          <label className="flex min-w-0 flex-col gap-2 text-sm">
            {t("hotspot.ssid")}<Input value={ssid} spellCheck={false} autoComplete="off" aria-invalid={!ssidValid} onChange={(e) => setSSID(e.target.value)} />
            {!ssidValid && <span className="text-xs text-muted-foreground">{t("hotspot.ssidRules")}</span>}
          </label>
          <label className="flex min-w-0 flex-col gap-2 text-sm">
            {t("hotspot.newPassword")}<PasswordInput
              value={password}
              placeholder={t("hotspot.keepPassword")}
              autoComplete="new-password"
              aria-invalid={!passwordValid}
              onChange={(e) => setPassword(e.target.value)}
            />
            {!passwordValid && <span className="text-xs text-muted-foreground">{t("hotspot.passwordRules")}</span>}
          </label>
          <label className="flex min-w-0 flex-col gap-2 text-sm">
            {t("hotspot.channel")}<NativeSelect className="w-full" value={channel} onChange={(e) => setChannel(Number(e.target.value))}>
              <option value={0}>{t("hotspot.automatic")}</option>
              {Array.from({ length: 11 }, (_, i) => i + 1).map((c) => (
                <option key={c} value={c}>
                  {t("hotspot.channelBand", { channel: c })}
                </option>
              ))}
            </NativeSelect>
          </label>
          <p className="text-xs text-muted-foreground col-span-full">
            {hotspot.active ? t("hotspot.restartHelp") : t("hotspot.bandHelp")}
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" type="button" onClick={() => setEditing(false)}>
              {t("common.cancel")}</Button>
            <Button variant="default" type="submit" disabled={locked || !ssidValid || !passwordValid}>
              {t("common.save")}</Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" disabled={locked} onClick={edit}>
            {t("hotspot.edit")}</Button>
        </div>
      )}

      {hotspot.active && (
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3 [&_h4]:font-medium">
            <h4>{t("hotspot.clients")}</h4>
            <span className="text-muted-foreground">{t("hotspot.clientCount", { count: hotspot.clients.length })}</span>
          </div>
          {hotspot.clients.length === 0 ? (
            <EmptyState icon={Wifi}>{t("hotspot.empty")}</EmptyState>
          ) : (
            <AnimatedList className="flex min-w-0 flex-col divide-y" label={t("hotspot.clients")} items={hotspot.clients} getKey={(c) => c.mac}>{(c) => (
                <div className="flex min-w-0 flex-wrap items-center gap-3 py-3">
                  <StatusDot tone="good" />
                  <strong>{c.hostname || t("hotspot.unknownDevice")}</strong>
                  <span className="font-mono break-all text-muted-foreground">{c.ip || t("hotspot.waitingAddress")}</span>
                  <span className="font-mono break-all text-muted-foreground">{c.mac}</span>
                </div>
              )}</AnimatedList>
          )}
        </div>
      )}
      {sharing && hotspot.active && <HotspotQR hotspot={hotspot} ip={ip} onClose={() => setSharing(false)} />}
    </div>
  );
}

function HotspotQR({ hotspot, ip, onClose }: { hotspot: Hotspot; ip: string; onClose: () => void }) {
  const t = useT();
  const [step, setStep] = useState<"join" | "panel" | "kvm">("join");
  const targets = {
    join: { title: t("hotspot.join"), text: wifiQRText(hotspot.ssid, hotspot.password),
      hint: t("hotspot.scanHelp"), detail: hotspot.ssid },
    panel: { title: t("nav.manager"), text: `http://${ip}`,
      hint: t("hotspot.openHelp"), detail: `http://${ip}` },
    kvm: { title: t("nav.apps"), text: `http://${ip}:8080`,
      hint: t("hotspot.openHelp"), detail: `http://${ip}:8080` },
  };
  const target = targets[step];
  return (
    <DetailsDialog open title={t("hotspot.scan")} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Segmented label={t("hotspot.qrContents")}>
        {(["join", "panel", "kvm"] as const).map((id, i) => (
          <SegmentedOption key={id} className="items-center text-center" title={`${i === 0 ? "① " : "② "}${targets[id].title}`} pressed={step === id} onClick={() => setStep(id)} />
        ))}
      </Segmented>
      <QRCode text={target.text} label={t("hotspot.qrLabel", { title: target.title })} />
      <p className="text-center text-sm font-mono break-all">{target.detail}</p>
      <p className="text-muted-foreground text-center text-sm">{target.hint}</p>
    </DetailsDialog>
  );
}

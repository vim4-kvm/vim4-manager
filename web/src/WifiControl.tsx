import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Segmented, SegmentedOption } from "@/components/Segmented";
import { Spinner } from "@/components/Spinner";
import { EmptyState } from "@/components/EmptyState";
import { AnimatedList } from "@/components/AnimatedList";
import { FadeIn } from "@/components/Motion";
import { Wifi, WifiHigh, WifiLow, WifiZero } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { InlineError } from "@/components/InlineError";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { SettingRow } from "@/components/SettingRow";
import { SettingsCard } from "@/components/SettingsCard";
import { StatusDot } from "@/components/StatusDot";
import { Switch } from "@/components/ui/switch";
import { useActionStore } from "@/stores/action";
import { useEffect, useState } from "react";
import { request, wifiWrite, type SavedWifi, type WifiNetwork, type WifiState } from "./api";
import { PasswordInput } from "@/components/PasswordInput";
import { WifiHotspot } from "./WifiHotspot";
import { t, useLocale } from "@/i18n";

type Confirm =
  | { kind: "off" }
  | { kind: "mode"; mode: "client" | "hotspot" }
  | { kind: "disconnect" }
  | { kind: "forget"; network: SavedWifi };

const PSK_PATTERN = /^([\x20-\x7e]{8,63}|[0-9a-fA-F]{64})$/;

export function SignalBars({ signal }: { signal: number }) {
  const level = signal >= 75 ? 4 : signal >= 50 ? 3 : signal >= 25 ? 2 : 1;
  const Icon = level === 4 ? Wifi : level === 3 ? WifiHigh : level === 2 ? WifiLow : WifiZero;
  return <Icon className="size-4 shrink-0 text-muted-foreground" role="img" aria-label={t("wifi.signal", { p0: signal })} />;
}

function band(frequency: number) {
  return frequency >= 5900 ? "6 GHz" : frequency >= 4900 ? "5 GHz" : "2.4 GHz";
}

export function WifiControl() {
  const locale = useLocale();
  const busy = useActionStore((s) => !!s.busy);
  const [reading, setReading] = useState(true);
  const [state, setState] = useState<WifiState>();
  const [error, setError] = useState("");
  const [stale, setStale] = useState(true);
  const [pending, setPending] = useState("");
  const [confirming, setConfirming] = useState<Confirm>();
  const [networks, setNetworks] = useState<WifiNetwork[]>();
  const [scanning, setScanning] = useState(false);
  const [joining, setJoining] = useState<{ ssid: string; secured: boolean; hidden: boolean }>();
  const [password, setPassword] = useState("");
  const [hiddenSSID, setHiddenSSID] = useState("");
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => {
    if (pending) return;
    let cancelled = false;
    let timer: number;
    async function refresh() {
      try {
        const next = await request<WifiState>("/api/wifi", undefined, AbortSignal.timeout(12000));
        if (!cancelled) {
          setState(next);
          setStale(false);
        }
      } catch {
        if (!cancelled) setStale(true);
      } finally {
        if (!cancelled) { setReading(false); timer = window.setTimeout(refresh, 3000); }
      }
    }
    void refresh();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pending, locale]);

  const clientMode = !!state?.supported && state.enabled && state.hardwareEnabled && state.mode === "client";

  async function scan(rescan: boolean) {
    if (rescan) setScanning(true);
    try {
      const result = await request<{ networks: WifiNetwork[] }>(
        `/api/wifi/networks${rescan ? "?rescan=1" : ""}`,
        undefined,
        AbortSignal.timeout(20000),
      );
      setNetworks(result.networks);
    } catch (e) {
      if (rescan) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (rescan) setScanning(false);
    }
  }

  useEffect(() => {
    if (!clientMode || pending) return;
    void scan(networks === undefined);
    const timer = window.setInterval(() => void scan(false), 15000);
    return () => window.clearInterval(timer);
  }, [clientMode, pending]);

  async function act(label: string, run: () => Promise<unknown>) {
    setPending(label);
    setError("");
    setConfirming(undefined);
    try {
      await run();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      // Only the next status read may update the view, including after a
      // lost response when the change drops the link carrying this session.
      setStale(true);
      setPending("");
    }
  }

  const toggleRadio = (enabled: boolean) =>
    act(enabled ? t("wifi.turningOn") : t("wifi.turningOff"), () => request("/api/wifi", { enabled }, AbortSignal.timeout(25000)));

  async function join() {
    if (!joining) return;
    const ssid = joining.hidden ? hiddenSSID : joining.ssid;
    const ok = await act(t("wifi.connectingTo", { p0: String(ssid) }), () =>
      wifiWrite("/connect", { ssid, password: joining.secured ? password : "", hidden: joining.hidden }),
    );
    if (ok) {
      setJoining(undefined);
      setPassword("");
      setHiddenSSID("");
    }
  }

  const locked = busy || !!pending || stale;
  const label = pending
    ? pending
    : stale
      ? t("wifi.statusUnavailable")
      : !state?.supported
        ? t("wifi.noWiFiAdapterDetected")
        : !state.hardwareEnabled
          ? t("wifi.wiFiHardwareDisabled")
          : state.enabled
            ? t("wifi.on")
            : t("wifi.off");

  const on = !!state?.supported && state.hardwareEnabled && state.enabled;
  const current = state?.current;
  const saved = state?.saved ?? [];
  const visible = (networks ?? []).filter((n) => !n.active);
  const ssidBytes = new TextEncoder().encode(hiddenSSID).length;
  const joinSSIDValid = !joining?.hidden || (ssidBytes >= 1 && ssidBytes <= 32);
  const joinPasswordValid = !joining?.secured || PSK_PATTERN.test(password);
  const hotspotName = state?.hotspot?.ssid;

  if (reading && !state) return <SettingsCard label="Wi-Fi"><PanelSkeleton label={label} /></SettingsCard>;

  return (
    <SettingsCard label="Wi-Fi"><FadeIn className="flex min-w-0 flex-col gap-5">
        <div className="flex items-start gap-4 [&_h3]:text-base [&_h3]:font-medium"><div className="rounded-xl bg-muted p-3"><Wifi className="size-6" aria-hidden="true" /></div><div className="min-w-0 flex-1"><SettingRow title="Wi-Fi" description={t("wifi.joinAWiFiNetworkOr")}
          status={label} pending={!!pending} control={<Switch aria-label="Wi-Fi" checked={!!state?.enabled}
            disabled={locked || !state?.supported || !state.hardwareEnabled}
            onCheckedChange={() => (state?.enabled ? setConfirming({ kind: "off" }) : void toggleRadio(true))} />} /></div></div>

        {on && state.mode && state.mode !== "off" && (
          <div className="flex min-w-0 flex-col gap-5">
            <Segmented label={t("wifi.wiFiMode")} className="max-sm:grid-cols-1">
              <SegmentedOption title={t("wifi.joinNetwork")} detail={t("wifi.connectTheBoardToWiFi")} pressed={state.mode === "client"} disabled={locked}
                onClick={() => state.mode !== "client" && setConfirming({ kind: "mode", mode: "client" })} />
              <SegmentedOption title={t("wifi.hotspot")} detail={t("wifi.connectDevicesToTheBoard")} pressed={state.mode === "hotspot"} disabled={locked}
                onClick={() => state.mode !== "hotspot" && setConfirming({ kind: "mode", mode: "hotspot" })} />
            </Segmented>

            {state.mode === "client" && (
              <>
                <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-foreground/15 bg-muted/50 p-4">
                  <StatusDot tone={current ? "good" : state.state === "connecting" ? "warning" : "idle"} />
                  {current ? (
                    <>
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5 [overflow-wrap:anywhere]">
                        <span className="font-medium">{current.ssid}</span>
                        <span className="text-xs text-muted-foreground">
                          {[current.ipv4, band(current.frequency), current.security?.replace(/WPA2 WPA3/g, "WPA2/WPA3") || t("wifi.openNetwork")].filter(Boolean).join(" · ")}
                        </span>
                      </div>
                      <SignalBars signal={current.signal} />
                      <Button variant="outline" disabled={locked} onClick={() => setConfirming({ kind: "disconnect" })}>
                        {t("wifi.disconnect")}</Button>
                    </>
                  ) : (
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5 [overflow-wrap:anywhere]">
                      <span className="font-medium">{state.state === "connecting" ? t("wifi.connecting") : t("wifi.notConnected")}</span>
                      <span className="text-xs text-muted-foreground">{t("wifi.chooseANetworkBelow")}</span>
                    </div>
                  )}
                </div>

                <div className="-mb-2 flex flex-wrap items-center justify-between gap-3">
                  <h4 className="text-sm font-medium">{t("wifi.nearbyNetworks")}</h4>
                  <Button variant="outline" disabled={locked || scanning} aria-busy={scanning} onClick={() => void scan(true)}>
                    {scanning && <Spinner />}
                    {scanning ? t("wifi.scanning") : t("wifi.scanAgain")}
                  </Button>
                </div>
                {networks === undefined ? (
                  <PanelSkeleton label={t("wifi.scanning23")} rows={2} />
                ) : visible.length === 0 ? (
                  <EmptyState icon={Wifi}>{t("wifi.noOtherNetworksFound")}</EmptyState>
                ) : (
                  <AnimatedList className="flex flex-col divide-y overflow-hidden rounded-md border [&_li]:min-w-0" label={t("wifi.nearbyNetworks")} items={visible} getKey={(n) => n.ssid}>{(n) => {
                      const open = joining && !joining.hidden && joining.ssid === n.ssid;
                      return (
                        <div className={open ? "bg-accent" : undefined}>
                          <Button variant="ghost"
                            type="button"
                            className="h-auto w-full min-w-0 flex-wrap justify-start gap-3 rounded-none px-3 py-2.5 text-left font-normal whitespace-normal"
                            disabled={locked}
                            aria-expanded={!!open}
                            onClick={() => {
                              if (n.saved) {
                                const entry = saved.find((s) => s.ssid === n.ssid);
                                if (entry) return void act(t("wifi.connectingTo", { p0: String(n.ssid) }), () => wifiWrite("/activate", { id: entry.id }));
                              }
                              setPassword("");
                              setJoining(open ? undefined : { ssid: n.ssid, secured: !!n.security, hidden: false });
                            }}
                          >
                            <SignalBars signal={n.signal} />
                            <span className="min-w-0 flex-1 break-all font-medium">{n.ssid}</span>
                            {n.saved && <Badge variant="secondary">{t("wifi.saved")}</Badge>}
                            <span className="text-muted-foreground ml-auto text-xs">
                              {n.security?.replace(/WPA2 WPA3/g, "WPA2/WPA3") || t("wifi.openNetwork")} · {band(n.frequency)}
                            </span>
                          </Button>
                          {open && (
                            <JoinForm
                              secured={joining.secured}
                              password={password}
                              setPassword={setPassword}
                              valid={joinPasswordValid}
                              locked={locked}
                              onCancel={() => setJoining(undefined)}
                              onJoin={() => void join()}
                            />
                          )}
                        </div>
                      );
                    }}</AnimatedList>
                )}
                <div className="flex flex-wrap items-center gap-4">
                  <Button variant="link" size="inline"
                    type="button"
                    disabled={locked}
                    onClick={() => {
                      setPassword("");
                      setHiddenSSID("");
                      setJoining(joining?.hidden ? undefined : { ssid: "", secured: true, hidden: true });
                    }}
                  >
                    {t("wifi.joinHiddenNetwork")}</Button>
                  {saved.length > 0 && (
                    <Button variant="link" size="inline" type="button" aria-expanded={showSaved} onClick={() => setShowSaved(!showSaved)}>
                      {t("wifi.savedCount", { count: saved.length })}
                    </Button>
                  )}
                </div>
                {joining?.hidden && (
                  <div className="flex flex-col gap-4 rounded-md border p-4">
                    <label className="flex min-w-0 flex-col gap-2 text-sm">
                      {t("wifi.networkNameSsid")}<Input
                        value={hiddenSSID}
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={!!hiddenSSID && !joinSSIDValid}
                        onChange={(e) => setHiddenSSID(e.target.value)}
                      />
                    </label>
                    <label className="flex items-start gap-2 text-sm">
                      <Checkbox className="mt-0.5"
                        checked={!joining.secured}
                        onCheckedChange={(value) => setJoining({ ...joining, secured: value !== true })}
                      />
                      {t("wifi.openNetworkNoPassword")}</label>
                    <JoinForm
                      secured={joining.secured}
                      password={password}
                      setPassword={setPassword}
                      valid={joinPasswordValid && joinSSIDValid && !!hiddenSSID}
                      locked={locked}
                      onCancel={() => setJoining(undefined)}
                      onJoin={() => void join()}
                    />
                  </div>
                )}
                {showSaved && saved.length > 0 && (
                  <AnimatedList className="flex flex-col divide-y rounded-md border [&_li]:min-w-0 " label={t("wifi.savedNetworks30")} items={saved} getKey={(s) => s.id}>{(s) => (
                      <>
                        <div className="flex min-w-0 flex-wrap items-center gap-3 p-3">
                          <span className="min-w-0 flex-1 break-all font-medium">
                            {s.ssid}
                            {s.active && <Badge variant="outline">{t("wifi.current")}</Badge>}
                          </span>
                          <label className="flex items-start gap-2 text-sm [&_input]:mt-1">
                            <input className="accent-primary"
                              type="checkbox"
                              checked={s.autoconnect}
                              disabled={locked}
                              onChange={(e) =>
                                void act(t("common.saving"), () => wifiWrite("/autoconnect", { id: s.id, enabled: e.target.checked }))
                              }
                            />
                            {t("wifi.connectAutomatically")}</label>
                          {!s.active && (
                            <Button variant="outline"
                              disabled={locked}
                              onClick={() => void act(t("wifi.connectingTo", { p0: String(s.ssid) }), () => wifiWrite("/activate", { id: s.id }))}
                            >
                              {t("wifi.connect")}</Button>
                          )}
                          <Button variant="outline" disabled={locked} onClick={() => setConfirming({ kind: "forget", network: s })}>
                            {t("wifi.forget")}</Button>
                        </div>
                      </>
                    )}</AnimatedList>
                )}
              </>
            )}

            {state.mode === "hotspot" && state.hotspot && (
              <WifiHotspot hotspot={state.hotspot} locked={locked} act={act} />
            )}
          </div>
        )}

        {confirming && (
          <ConfirmDialog open title={confirmTitle(confirming)} description={confirmText(confirming, state, hotspotName)}
            confirm={confirmTitle(confirming)} destructive disabled={locked} onOpenChange={(open) => { if (!open) setConfirming(undefined); }}
            onConfirm={() => void runConfirm(confirming)} />
        )}

        {error && (
          <InlineError>
            {error}
          </InlineError>
        )}
      </FadeIn></SettingsCard>
  );

  function runConfirm(c: Confirm) {
    switch (c.kind) {
      case "off":
        return toggleRadio(false);
      case "mode":
        return act(c.mode === "hotspot" ? t("wifi.startingHotspot") : t("wifi.switchingToWiFi"), () =>
          wifiWrite("/mode", { mode: c.mode, force: c.mode === "client" && !keepHotspotFallback(state) }),
        );
      case "disconnect":
        return act(t("wifi.disconnecting"), () => wifiWrite("/disconnect", {}));
      case "forget":
        return act(t("wifi.deleting"), () => wifiWrite("/forget", { id: c.network.id }));
    }
  }
}

// Restoring the hotspot only helps a session that arrived over it and has a
// saved network to try; otherwise it would block choosing a network at all.
function keepHotspotFallback(state: WifiState | undefined) {
  return !!state?.viaWifi && !!state.saved?.length;
}

function confirmTitle(c: Confirm) {
  switch (c.kind) {
    case "off":
      return t("wifi.turnOffWiFi");
    case "mode":
      return c.mode === "hotspot" ? t("wifi.startHotspot") : t("wifi.switchToWiFi");
    case "disconnect":
      return t("wifi.disconnect");
    case "forget":
      return t("wifi.forgetNetwork");
  }
}

function confirmText(c: Confirm, state: WifiState | undefined, hotspotName?: string) {
  const remote = !!state?.viaWifi;
  switch (c.kind) {
    case "off":
      return t("wifi.turningOffWiFiDisconnectsWireless");
    case "mode":
      if (c.mode === "hotspot") return t(remote ? "wifi.startHotspotRemoteHelp" : "wifi.startHotspotHelp", {
        name: hotspotName || "", address: (state?.hotspot?.address || "10.42.0.1").split("/")[0],
      });
      if (keepHotspotFallback(state)) return t("wifi.clientFallbackHelp");
      return state?.saved?.length
        ? t(remote ? "wifi.clientSavedRemoteHelp" : "wifi.clientSavedHelp")
        : t(remote ? "wifi.clientEmptyRemoteHelp" : "wifi.clientEmptyHelp");
    case "disconnect":
      return t(remote ? "wifi.disconnectRemoteHelp" : "wifi.disconnectHelp", { name: state?.current?.ssid || "" });
    case "forget":
      return t(c.network.active ? remote ? "wifi.forgetActiveRemoteHelp" : "wifi.forgetActiveHelp" : "wifi.forgetHelp", { name: c.network.ssid });
  }
}

function JoinForm(props: {
  secured: boolean;
  password: string;
  setPassword: (v: string) => void;
  valid: boolean;
  locked: boolean;
  onCancel: () => void;
  onJoin: () => void;
}) {
  return (
    <form aria-label={t("wifi.joinNetwork")}
      className="flex flex-col gap-4 border-t p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (props.valid && !props.locked) props.onJoin();
      }}
    >
      {props.secured && (
        <label className="flex min-w-0 flex-col gap-2 text-sm">
          {t("login.password")}<PasswordInput
            value={props.password}
            autoComplete="off"
            autoFocus
            aria-invalid={!!props.password && !props.valid}
            onChange={(e) => props.setPassword(e.target.value)}
          />
          {!!props.password && !props.valid && <span className="text-xs text-muted-foreground">{t("wifi.useCharactersOrADigitHexadecimal")}</span>}
        </label>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" type="button" onClick={props.onCancel}>
          {t("common.cancel")}</Button>
        <Button variant="default" type="submit" disabled={props.locked || !props.valid}>
          {t("wifi.connect")}</Button>
      </div>
    </form>
  );
}

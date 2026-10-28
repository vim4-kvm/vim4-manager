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

type Confirm =
  | { kind: "off" }
  | { kind: "mode"; mode: "client" | "hotspot" }
  | { kind: "disconnect" }
  | { kind: "forget"; network: SavedWifi };

const PSK_PATTERN = /^([\x20-\x7e]{8,63}|[0-9a-fA-F]{64})$/;

export function SignalBars({ signal }: { signal: number }) {
  const level = signal >= 75 ? 4 : signal >= 50 ? 3 : signal >= 25 ? 2 : 1;
  const Icon = level === 4 ? Wifi : level === 3 ? WifiHigh : level === 2 ? WifiLow : WifiZero;
  return <Icon className="size-4 shrink-0 text-muted-foreground" role="img" aria-label={`信号 ${signal}%`} />;
}

function band(frequency: number) {
  return frequency >= 5900 ? "6 GHz" : frequency >= 4900 ? "5 GHz" : "2.4 GHz";
}

export function WifiControl() {
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
  }, [pending]);

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
    act(enabled ? "正在开启…" : "正在关闭…", () => request("/api/wifi", { enabled }, AbortSignal.timeout(25000)));

  async function join() {
    if (!joining) return;
    const ssid = joining.hidden ? hiddenSSID : joining.ssid;
    const ok = await act(`正在连接 ${ssid}…`, () =>
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
      ? "状态暂不可用"
      : !state?.supported
        ? "未检测到无线网卡"
        : !state.hardwareEnabled
          ? "无线硬件已禁用"
          : state.enabled
            ? "已开启"
            : "已关闭";

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
        <div className="flex items-start gap-4 [&_h3]:text-base [&_h3]:font-semibold"><div className="rounded-xl bg-muted p-3"><Wifi className="size-6" aria-hidden="true" /></div><div className="min-w-0 flex-1"><SettingRow title="Wi-Fi" description="连接到无线网络或创建热点，两种模式互斥。有线网络不受影响。"
          status={label} pending={!!pending} control={<Switch aria-label="Wi-Fi" checked={!!state?.enabled}
            disabled={locked || !state?.supported || !state.hardwareEnabled}
            onCheckedChange={() => (state?.enabled ? setConfirming({ kind: "off" }) : void toggleRadio(true))} />} /></div></div>

        {on && state.mode && state.mode !== "off" && (
          <div className="flex min-w-0 flex-col gap-5">
            <Segmented label="无线模式" className="max-sm:grid-cols-1">
              <SegmentedOption title="连接网络" detail="板子加入现有 Wi-Fi" pressed={state.mode === "client"} disabled={locked}
                onClick={() => state.mode !== "client" && setConfirming({ kind: "mode", mode: "client" })} />
              <SegmentedOption title="热点" detail="其他设备连入板子" pressed={state.mode === "hotspot"} disabled={locked}
                onClick={() => state.mode !== "hotspot" && setConfirming({ kind: "mode", mode: "hotspot" })} />
            </Segmented>

            {state.mode === "client" && (
              <>
                <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-chart-1/20 bg-chart-1/3 p-4">
                  <StatusDot tone={current ? "good" : state.state === "connecting" ? "warning" : "idle"} />
                  {current ? (
                    <>
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5 [overflow-wrap:anywhere]">
                        <span className="font-medium">{current.ssid}</span>
                        <span className="text-xs text-muted-foreground">
                          {[current.ipv4, band(current.frequency), current.security || "开放网络"].filter(Boolean).join(" · ")}
                        </span>
                      </div>
                      <SignalBars signal={current.signal} />
                      <Button variant="outline" disabled={locked} onClick={() => setConfirming({ kind: "disconnect" })}>
                        断开
                      </Button>
                    </>
                  ) : (
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5 [overflow-wrap:anywhere]">
                      <span className="font-medium">{state.state === "connecting" ? "正在连接…" : "未连接"}</span>
                      <span className="text-xs text-muted-foreground">从下方列表选择网络。</span>
                    </div>
                  )}
                </div>

                <div className="-mb-2 flex flex-wrap items-center justify-between gap-3">
                  <h4 className="text-sm font-medium">附近的网络</h4>
                  <Button variant="outline" disabled={locked || scanning} aria-busy={scanning} onClick={() => void scan(true)}>
                    {scanning && <Spinner />}
                    {scanning ? "扫描中" : "重新扫描"}
                  </Button>
                </div>
                {networks === undefined ? (
                  <PanelSkeleton label="正在扫描…" rows={2} />
                ) : visible.length === 0 ? (
                  <EmptyState icon={Wifi}>没有发现其他网络。</EmptyState>
                ) : (
                  <AnimatedList className="flex flex-col divide-y overflow-hidden rounded-md border [&_li]:min-w-0" label="附近的网络" items={visible} getKey={(n) => n.ssid}>{(n) => {
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
                                if (entry) return void act(`正在连接 ${n.ssid}…`, () => wifiWrite("/activate", { id: entry.id }));
                              }
                              setPassword("");
                              setJoining(open ? undefined : { ssid: n.ssid, secured: !!n.security, hidden: false });
                            }}
                          >
                            <SignalBars signal={n.signal} />
                            <span className="min-w-0 flex-1 break-all font-medium">{n.ssid}</span>
                            {n.saved && <Badge variant="secondary">已保存</Badge>}
                            <span className="text-muted-foreground ml-auto text-xs">
                              {n.security || "开放网络"} · {band(n.frequency)}
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
                    加入隐藏网络
                  </Button>
                  {saved.length > 0 && (
                    <Button variant="link" size="inline" type="button" aria-expanded={showSaved} onClick={() => setShowSaved(!showSaved)}>
                      已保存的网络（{saved.length}）
                    </Button>
                  )}
                </div>
                {joining?.hidden && (
                  <div className="flex flex-col gap-4 rounded-md border p-4">
                    <label className="flex min-w-0 flex-col gap-2 text-sm">
                      网络名称（SSID）
                      <Input
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
                      开放网络（无密码）
                    </label>
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
                  <AnimatedList className="flex flex-col divide-y rounded-md border [&_li]:min-w-0 " label="已保存的网络" items={saved} getKey={(s) => s.id}>{(s) => (
                      <>
                        <div className="flex min-w-0 flex-wrap items-center gap-3 p-3">
                          <span className="min-w-0 flex-1 break-all font-medium">
                            {s.ssid}
                            {s.active && <Badge variant="outline">当前</Badge>}
                          </span>
                          <label className="flex items-start gap-2 text-sm [&_input]:mt-1">
                            <input className="accent-primary"
                              type="checkbox"
                              checked={s.autoconnect}
                              disabled={locked}
                              onChange={(e) =>
                                void act("正在保存…", () => wifiWrite("/autoconnect", { id: s.id, enabled: e.target.checked }))
                              }
                            />
                            自动连接
                          </label>
                          {!s.active && (
                            <Button variant="outline"
                              disabled={locked}
                              onClick={() => void act(`正在连接 ${s.ssid}…`, () => wifiWrite("/activate", { id: s.id }))}
                            >
                              连接
                            </Button>
                          )}
                          <Button variant="outline" disabled={locked} onClick={() => setConfirming({ kind: "forget", network: s })}>
                            忘记
                          </Button>
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
        return act(c.mode === "hotspot" ? "正在开启热点…" : "正在切换到连接网络…", () =>
          wifiWrite("/mode", { mode: c.mode, force: c.mode === "client" && !keepHotspotFallback(state) }),
        );
      case "disconnect":
        return act("正在断开…", () => wifiWrite("/disconnect", {}));
      case "forget":
        return act("正在删除…", () => wifiWrite("/forget", { id: c.network.id }));
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
      return "关闭 Wi-Fi";
    case "mode":
      return c.mode === "hotspot" ? "开启热点" : "切换到连接网络";
    case "disconnect":
      return "断开";
    case "forget":
      return "忘记网络";
  }
}

function confirmText(c: Confirm, state: WifiState | undefined, hotspotName?: string) {
  const via = state?.viaWifi ? "你当前正通过 Wi-Fi 访问此页面，会话会断开。" : "";
  switch (c.kind) {
    case "off":
      return "关闭会断开 Wi-Fi 连接和热点。如果当前通过 Wi-Fi 访问，请改用有线网络。";
    case "mode":
      return c.mode === "hotspot"
        ? `${via}${state?.current ? `板子将断开「${state.current.ssid}」，` : "板子将"}发出热点「${hotspotName}」。连入后访问 http://${(state?.hotspot?.address || "10.42.0.1").split("/")[0]} 打开管理面板。`
        : keepHotspotFallback(state)
          ? `${via}热点将关闭，已连入的设备会断开。板子会自动连接已保存的网络；30 秒内连不上会自动恢复热点。`
          : `${via}热点将关闭，已连入的设备会断开。${state?.saved?.length ? "板子会尝试连接已保存的网络，" : "之后可在列表中选择网络连接，"}连不上时不会恢复热点。`;
    case "disconnect":
      return `${via}断开「${state?.current?.ssid}」后不会自动重连，直到手动连接或板子重启。`;
    case "forget":
      return `删除「${c.network.ssid}」的保存密码${c.network.active ? "，并断开当前连接" : ""}。${c.network.active ? via : ""}`;
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
    <form aria-label="连接网络"
      className="flex flex-col gap-4 border-t p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (props.valid && !props.locked) props.onJoin();
      }}
    >
      {props.secured && (
        <label className="flex min-w-0 flex-col gap-2 text-sm">
          密码
          <PasswordInput
            value={props.password}
            autoComplete="off"
            autoFocus
            aria-invalid={!!props.password && !props.valid}
            onChange={(e) => props.setPassword(e.target.value)}
          />
          {!!props.password && !props.valid && <span className="text-xs text-muted-foreground">8–63 位字符，或 64 位十六进制密钥</span>}
        </label>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" type="button" onClick={props.onCancel}>
          取消
        </Button>
        <Button variant="default" type="submit" disabled={props.locked || !props.valid}>
          连接
        </Button>
      </div>
    </form>
  );
}

import { number } from "@/i18n/format";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { request, type PassthroughState } from "@/api";
import { MonitorOff } from "lucide-react";
import { DeviceConnections } from "@/components/DeviceConnections";
import { EmptyState } from "@/components/EmptyState";
import { Fact, FactGrid } from "@/components/FactGrid";
import { InlineError } from "@/components/InlineError";
import { Collapse, FadeIn } from "@/components/Motion";
import { SettingRow } from "@/components/SettingRow";
import { SettingsCard } from "@/components/SettingsCard";
import { PageHeading } from "@/components/PageHeading";
import { Notice } from "@/components/Notice";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useActionStore } from "@/stores/action";
import { usePassthroughStore } from "@/stores/passthrough";
import { useStatusStore } from "@/stores/status";
import { t, useLocale } from "@/i18n";

const labels: Record<PassthroughState["state"], string> = {
  get unsupported() { return t("output.unavailableOnThisKernel"); },
  get off() { return t("output.off"); },
  get starting() { return t("connections.turningOn"); },
  get stopping() { return t("connections.turningOff"); },
  get running() { return t("connections.passthroughActive"); },
  get "no-signal"() { return t("connections.waitingForInput"); },
  get "no-monitor"() { return t("connections.noDisplayConnected"); },
  get protected() { return t("connections.protectedInput"); },
  get "unsupported-format"() { return t("output.unsupportedInputFormat"); },
  get "video-error"() { return t("connections.inputSignalProblem"); },
};

const descriptions = {
  get unsupported() { return <>{t("output.unsupportedHelp")} <a href="#/updates" className="text-link underline-offset-4 hover:underline">{t("output.updatesKernel")}</a></>; },
  get off() { return t("output.whenOnTheDisplayShowsThe"); },
  get running() { return t("output.remoteKvmStaysConnectedTheLocal"); },
  get "no-signal"() { return t("output.noHdmiInSignalTheDisplay"); },
  get "no-monitor"() { return t("output.passthroughStartsAutomaticallyWhenADisplay"); },
  get protected() { return t("output.theTargetComputerIsPlayingHdcp"); },
  get "unsupported-format"() { return t("output.thisFormatCannotPassThroughSelect"); },
  get "video-error"() { return t("output.checkTheHdmiInputCableAnd"); },
};

function refreshLabel(hz: number) {
  return `${number(hz, {maximumFractionDigits:2})} Hz`;
}

function mode(width: number, height: number, hz: number) {
  return `${width}×${height} ${refreshLabel(hz)}`;
}

/** Same shape as the loaded card; the reading text stays for screen readers. */
function PassthroughSkeleton() {
 useLocale();
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <span className="sr-only">{t("output.loadingPassthroughStatus")}</span>
      <div className="flex items-center justify-between gap-6">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-5 w-32" />
      </div>
      <div className="grid grid-cols-1 gap-x-8 gap-y-4 @md:grid-cols-3">
        {[0, 1, 2].map((i) => <div key={i} className="flex flex-col gap-1.5"><Skeleton className="h-3 w-10" /><Skeleton className="h-5 w-32" /></div>)}
      </div>
      <Skeleton className="h-4 w-3/4" />
    </div>
  );
}

export function PassthroughPanel() {
 useLocale();
  const locale = useLocale();
  const status = useStatusStore((s) => s.status);
  const busy = useActionStore((s) => !!s.busy);
  const run = useActionStore((s) => s.run);
  const stale = useStatusStore((s) => s.stale);
  const onState = usePassthroughStore((s) => s.setState);
  const [state, setState] = useState<PassthroughState>();
  const [error, setError] = useState<string>();
  const [readStale, setReadStale] = useState(true);
  const [pending, setPending] = useState<"starting" | "stopping" | "audio" | "hdr">();
  const [hdrTarget, setHdrTarget] = useState(true);
  const [description, setDescription] = useState<ReactNode>(descriptions.off);
  const mounted = useRef(false);
  const actionPending = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const accept = useCallback((next: PassthroughState) => {
    setState(next);
    setError(undefined);
    setReadStale(false);
    onState(next);
    if (next.state !== "starting" && next.state !== "stopping") setDescription(next.reason || descriptions[next.state]);
  }, [onState]);

  useEffect(() => {
    if (busy || pending) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await request<PassthroughState>("/api/passthrough", undefined,
          AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
        if (!controller.signal.aborted && !actionPending.current) accept(next);
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : String(e));
          setReadStale(true);
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 2000);
      }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [busy, pending, accept, locale]);

  async function change(body: { enabled?: boolean; audio?: boolean; hdr?: boolean }) {
    if (actionPending.current) return;
    actionPending.current = true;
    const transition = body.hdr !== undefined ? "hdr" : body.enabled === undefined ? "audio" : body.enabled ? "starting" : "stopping";
    if (body.hdr !== undefined) setHdrTarget(body.hdr);
    setPending(transition);
    const errorKey = transition === "hdr" ? "output.saveHdrFailed" : body.enabled === undefined ? "output.saveAudioFailed" : body.enabled ? "output.enableFailed" : "output.disableFailed";
    await run(transition === "hdr" ? t("output.switchingHdr") : transition === "audio" ? t("output.savingAudioSettings") : labels[transition], async () => {
      try {
        const next = await request<PassthroughState>("/api/passthrough", body, AbortSignal.timeout(20000));
        if (mounted.current) accept(next);
      } catch (e) {
        let reason = e instanceof Error ? e.message : String(e);
        if (transition === "hdr" && !/^[\u3400-\u9fff\s，。；、！…（）·]+$/.test(reason.replaceAll("HDR", ""))) {
          reason = t("output.couldnTApplyHdrSettingsTry");
        }
        throw new Error(t(errorKey, { reason }));
      }
    }, transition === "hdr" ? body.hdr ? t("output.hdrPassthroughEnabled") : t("output.outputConvertedToSdr")
      : body.enabled === undefined ? t("output.audioSettingsSaved") : body.enabled ? t("output.passthroughEnabled") : t("connections.passthroughOff"));
    // A failed or lost response may still have changed the kernel. Keep the
    // old facts and lock controls until a fresh GET establishes actual state.
    if (mounted.current) {
      setReadStale(true);
      setPending(undefined);
    }
    actionPending.current = false;
  }

  if (!state) return <><PageHeading page="output" /><SettingsCard label={t("output.passthrough")}>
    {error ? <InlineError>{t("output.loadFailed", { reason: error })}</InlineError> : <PassthroughSkeleton />}
  </SettingsCard></>;

  const current = pending === "starting" || pending === "stopping" ? pending : state.state;
  const transitioning = current === "starting" || current === "stopping";
  const locked = busy || stale || readStale || !!pending || transitioning || !state.supported;
  const enabled = current === "starting" || (current !== "stopping" && current !== "unsupported" && state.enabled);
  const input = state.input;
  const monitor = state.monitor;
  const output = state.output;
  let outputValue = state.state === "off" || state.state === "unsupported" ? t("output.systemConsole") : "—";
  let outputDetail: string | undefined;
  let outputTone: "good" | "warning" | "idle" = "idle";
  if (state.state === "no-signal" || state.state === "protected") outputValue = t("output.blackScreen");
  if (state.state === "running" && output) {
    outputValue = mode(output.width, output.height, output.refreshHz);
    outputTone = output.scaled ? "warning" : "good";
    outputDetail = output.scaled && input
      ? t("output.scaledTheDisplayDoesnTSupport", { p0: String(mode(input.width, input.height, input.refreshHz)) }) : output.colorFormat;
    if (output.hdrToSdr) {
      const mapping = monitor && !monitor.hdr ? t("output.convertedToSdrDisplayHasNo") : t("output.convertedToSdr");
      outputDetail = `${outputDetail} · ${mapping}`;
    } else if (input && ["HDR10", "HLG"].includes(input.hdr)) {
      outputDetail = `${input.hdr} · BT.2020 · ${output.colorFormat.replace(/ limited$/, "")}`;
    }
  }
  if (transitioning) {
    outputValue = t("output.switching");
    outputDetail = undefined;
    outputTone = "idle";
  }
  const audioUnsupported = !!monitor && !monitor.audio;
  const hdr = state.hdr ?? true;
  const hdrUnsupported = !!monitor && !monitor.hdr;
  const hdrLabel = pending === "hdr" ? t("output.switching317")
    : current === "starting" ? t("output.appliesWhenPassthroughStarts") : current === "stopping" ? t("output.off")
    : !state.enabled ? t("output.appliesWhenPassthroughStarts") : hdrUnsupported ? t("output.displayHasNoHdrSupport")
    : !input ? t("connections.waitingForInput") : input.hdr === "SDR" ? t("video.sdrInput")
    : hdr && current === "running" && output && !output.hdrToSdr ? t("output.hdrOutputActive")
    : !hdr && current === "running" && output?.hdrToSdr ? t("output.convertedToSdr321") : t("output.applying");
  const hdrInactive = pending !== "hdr" && (transitioning || !state.enabled || hdrUnsupported || !input || input.hdr === "SDR");
  const audioEffective = state.enabled && state.audio && !!input?.audio && !!monitor?.audio
    && (state.audioState ? state.audioState === "running" : current === "running");
  const audioLabel = current === "starting" ? t("output.appliesWhenPassthroughStarts") : current === "stopping" ? t("output.off")
    : !state.enabled ? t("output.appliesWhenPassthroughStarts") : audioUnsupported ? t("output.displayHasNoAudioSupport")
    : !state.audio ? t("output.off") : !input?.audio ? t("output.noInputAudio")
    : ["error", "unavailable"].includes(state.audioState || "") ? t("output.audioUnavailable")
    : state.audioState && state.audioState !== "running" ? t("output.connectingAudio") : t("output.outputActive");

  return <>
    <PageHeading page="output" />
    <section role="region" aria-label={t("output.passthrough")} className="flex min-w-0 flex-col gap-5">
    <SettingsCard title={t("output.signalPath")} description={t("output.viewHdmiUsbCAndNetwork")}>
    <FadeIn><SettingRow title={t("output.passthrough")} description={t("output.sendHdmiInVideoToThe")}
      status={labels[current]} pending={transitioning}
      control={<Switch aria-label={t("output.passthrough")} checked={enabled} disabled={locked}
        onCheckedChange={() => void change({ enabled: !state.enabled })} />} /></FadeIn>
    <FadeIn><DeviceConnections status={status} passthrough={{ ...state, state: current }} stale={stale || readStale} /></FadeIn>
    <FadeIn className="flex flex-col gap-4" data-passthrough-body>
      <Collapse open={state.supported}>
        <FactGrid>
          <Fact label={t("output.input")} value={input ? mode(input.width, input.height, input.refreshHz) : t("overview.noSignal")}
            detail={input ? `${input.hdr} · ${input.colorFormat}` : undefined} tone={input ? "good" : "idle"} />
          <Fact label={t("output.display")} value={monitor ? monitor.name || t("output.unknownModel") : t("overview.notConnected")}
            detail={monitor ? t("output.upTo", { p0: String(mode(monitor.maxWidth, monitor.maxHeight, monitor.maxRefreshHz)), p1: String(monitor.hdr ? " · HDR" : "") }) : undefined}
            tone={monitor ? "good" : "idle"} />
          <Fact label={t("output.output")} value={outputValue} detail={outputDetail} tone={outputTone} />
        </FactGrid>
      </Collapse>
      <p data-description className="text-sm text-pretty text-muted-foreground">{description}</p>
      <Collapse open={!!error}>
        <InlineError>{t("output.refreshFailed", { reason: error || "" })}</InlineError>
      </Collapse>
    </FadeIn>
    </SettingsCard>
    {state.supported && <div className="grid items-start gap-5 lg:grid-cols-2">
    <SettingsCard title={t("output.outputSettings")}>
    {state.supported && <FadeIn><SettingRow title="HDR" description={t("output.passHdrVideoThroughWhenOn")}
      status={hdrLabel} inactive={hdrInactive} pending={pending === "hdr"}
      control={<Switch aria-label="HDR" checked={pending === "hdr" ? hdrTarget : hdr}
        disabled={locked || (state.enabled && hdrUnsupported)} onCheckedChange={() => void change({ hdr: !hdr })} />} /></FadeIn>}
    {state.supported && <FadeIn><SettingRow title={t("output.sound")} description={t("output.sendHdmiInAudioToThe")}
      status={audioLabel} inactive={!audioEffective}
      control={<Switch aria-label={t("output.sound")} checked={state.audio}
        disabled={locked || (state.enabled && audioUnsupported)} onCheckedChange={() => void change({ audio: !state.audio })} />} /></FadeIn>}
      <Notice>{t("output.theLocalDisplayMayBrieflyGo")}</Notice>
    </SettingsCard>
    <SettingsCard title={t("output.displayInformation")}>
      {monitor ? <dl className="space-y-4 text-sm">{[
        [t("output.model"), monitor.name || t("output.unknownModel")],
        [t("output.maximumResolution"), `${monitor.maxWidth}×${monitor.maxHeight}`],
        [t("output.maximumRefreshRate"), refreshLabel(monitor.maxRefreshHz)],
        ["HDR", monitor.hdr ? t("output.supported") : t("output.notSupported")],
        [t("output.audio"), monitor.audio ? t("output.supported") : t("output.notSupported")],
      ].map(([label, value], i) => <div className={`flex justify-between gap-6 ${i ? "border-t pt-4" : ""}`} key={label}><dt className="shrink-0 text-muted-foreground">{label}</dt><dd className="min-w-0 break-words text-right font-medium">{value}</dd></div>)}</dl>
        : <EmptyState icon={MonitorOff}>{t("output.noDisplayConnectedConnectOneTo")}</EmptyState>}
    </SettingsCard>
    </div>}
    </section>
  </>;
}

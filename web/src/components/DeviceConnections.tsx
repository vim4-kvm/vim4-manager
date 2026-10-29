import { number } from "@/i18n/format";
import { t, useLocale } from "@/i18n";
import { useId, useRef, useState } from "react";
import { ArrowUpRight, Computer, Keyboard, Monitor, Network, Usb, X, Zap, type LucideIcon } from "lucide-react";
import type { PassthroughState, Status } from "@/api";
import boardImage from "@/assets/vim4-board.webp";
import { powerConnection } from "@/lib/power";
import { hdrLabel } from "@/lib/units";
import { cn } from "@/lib/utils";
import { StatusLabel, type Tone } from "./StatusDot";
import { ConnectionLines } from "./ConnectionLines";
import "./DeviceConnections.css";

type Port = "input" | "output" | "network" | "usb";
type Connection = { title: string; label: string; value: string; detail: string; tone: Tone; href: string; destination: string; icon: LucideIcon };

const outputLabels: Record<PassthroughState["state"], string> = {
  get unsupported() { return t("connections.passthroughUnavailableOnThisKernel"); }, get off() { return t("connections.passthroughOff"); }, get starting() { return t("connections.turningOn"); }, get stopping() { return t("connections.turningOff"); },
  get running() { return t("connections.passthroughActive"); }, get "no-signal"() { return t("connections.waitingForInput"); }, get "no-monitor"() { return t("connections.noDisplayConnected"); }, get protected() { return t("connections.protectedInput"); },
  get "unsupported-format"() { return t("connections.unsupportedInputFormat"); }, get "video-error"() { return t("connections.inputSignalProblem"); },
};

function videoMode(width?: number, height?: number, hz?: number) {
  return width && height ? `${width}×${height}${hz ? ` · ${number(hz, {maximumFractionDigits:2})} Hz` : ""}` : t("connections.resolutionUnknown");
}

function connections(status?: Status, passthrough?: PassthroughState): Record<Port, Connection> {
  const hdmi = status?.hardware.hdmi;
  const input = passthrough?.input;
  const signal = passthrough?.supported ? !!input : hdmi?.signal;
  const ethernet = status?.system.links.find((link) => !link.wireless && link.name !== "usb0" && /^e(n|th)/.test(link.name));
  const speed = ethernet?.speedMbps;
  const usb = status?.hardware.usb;
  const power = powerConnection(status?.power);
  return {
    input: {
      title: t("connections.target"), label: "HDMI IN", icon: Computer, href: "#/video", destination: t("connections.videoInputSettings"),
      value: signal === undefined ? t("overview.statusUnknown") : signal ? t("connections.signalDetected") : t("overview.noSignal"),
      detail: signal ? `${videoMode(input?.width ?? hdmi?.width, input?.height ?? hdmi?.height, input?.refreshHz ?? hdmi?.refreshHz)} · ${input?.hdr || hdrLabel(hdmi?.hdr) || t("connections.colorInformationUnknown")}` : signal === false ? t("connections.checkTheTargetComputerAndHdmi") : t("connections.waitingForInputStatus"),
      tone: signal === undefined ? "idle" : signal ? "good" : "warning",
    },
    output: {
      title: t("connections.localDisplay"), label: "HDMI OUT", icon: Monitor, href: "#/output", destination: t("connections.hdmiOutputSettings"),
      value: passthrough ? outputLabels[passthrough.state] : t("overview.statusUnknown"),
      detail: passthrough?.monitor ? `${passthrough.monitor.name || t("connections.displayConnected")} · ${passthrough.state === "running" && passthrough.output ? videoMode(passthrough.output.width, passthrough.output.height, passthrough.output.refreshHz) : t("connections.displayConnected176")}`
        : passthrough?.state === "off" ? t("connections.showsTheSystemConsoleWhenPassthrough") : passthrough?.state === "no-monitor" ? t("connections.connectALocalDisplay") : t("connections.displayStatusUnknown"),
      tone: !passthrough || ["off", "unsupported", "starting", "stopping", "no-monitor"].includes(passthrough.state) ? "idle" : passthrough.state === "running" ? "good" : "warning",
    },
    network: {
      title: t("connections.ethernet"), label: t("connections.ethernetPort"), icon: Network, href: "#/network", destination: t("connections.networkSettings"),
      value: !ethernet ? t("overview.statusUnknown") : !ethernet.up ? t("overview.notConnected") : speed ? t("connections.connected", { p0: String(speed >= 1000 ? `${speed / 1000} Gbps` : `${speed} Mbps`) }) : t("overview.connected"),
      detail: ethernet ? `${ethernet.name} · ${ethernet.addrs?.find((addr) => !addr.includes(":")) || ethernet.addrs?.[0] || t("connections.noIpAddress")}` : t("connections.noEthernetAdapterDetected"),
      tone: ethernet?.up ? "good" : "idle",
    },
    usb: {
      title: "USB-C", label: t("connections.powerAndUsbInput"), icon: Usb, href: "#/services", destination: t("overview.systemServices"),
      value: usb === "configured" ? t("connections.keyboardAndMouseConnected") : !usb ? t("connections.usbInputStatusUnknown") : t("connections.waitingForKeyboardAndMouse"),
      detail: `${power.value} · ${power.detail}`, tone: usb === "configured" ? "good" : "idle",
    },
  };
}

/** Port positions are normalized to the unrotated Khadas VIM4 top-view photo. */
const ports: { id: Port; x: number; y: number; label: string }[] = [
  { id: "network", x: 31, y: 5, get label() { return t("connections.ethernetPort"); } },
  { id: "output", x: 53, y: 5, label: "HDMI OUT" },
  { id: "usb", x: 70.5, y: 5, label: "USB-C" },
  { id: "input", x: 16, y: 94, label: "HDMI IN" },
];

export function DeviceConnections({ status, passthrough = status?.passthrough, stale = false }: {
  status?: Status; passthrough?: PassthroughState; stale?: boolean;
}) {
 useLocale();
  const [selected, setSelected] = useState<Port>();
  const detailsId = useId();
  const mapRef = useRef<HTMLDivElement>(null);
  const data = connections(status, passthrough);
  const power = powerConnection(status?.power);
  const tone = (port: Port) => stale ? "idle" : data[port].tone;
  const selectedData = selected ? data[selected] : undefined;
  const select = (port: Port) => setSelected((current) => current === port ? undefined : port);
  return (
    <section aria-label={t("connections.deviceConnectionDiagram")} className="device-connections">
      {stale && <p role="status" className="mb-3 text-xs text-warning-foreground">{t("connections.connectionLostLastKnownStateShown")}</p>}
      <div className="connection-map" ref={mapRef}>
        <ConnectionLines mapRef={mapRef} tones={{ network: tone("network"), usb: tone("usb"), input: tone("input"), output: tone("output") }} />
        <div className="connection-board">
          <img src={boardImage} alt={t("connections.khadasNewVimBoardTopView")} width={1995} height={1414} className="block h-auto w-full" />
          {ports.map((port) => <button key={port.id} type="button" className="connection-port" style={{ left: `${port.x}%`, top: `${port.y}%` }}
            data-port={port.id} data-tone={tone(port.id)} data-selected={selected === port.id} aria-label={t("connections.port", { p0: String(port.label) })} aria-pressed={selected === port.id} aria-controls={detailsId}
            title={`${port.label} · ${data[port.id].value}`} onClick={() => select(port.id)}>
            <span className="connection-port-dot" /><span className={cn("connection-port-label", port.id === "input" && "connection-port-label-bottom")}>{port.label}</span>
          </button>)}
        </div>
        {(["network", "usb", "input", "output"] as const).map((port) => {
          const item = data[port];
          const Icon = item.icon;
          return <button key={port} type="button" className={`connection-endpoint connection-endpoint-${port}`} data-selected={selected === port}
            aria-label={t("connections.details", { p0: String(item.title), p1: String(item.label) })} aria-pressed={selected === port} aria-controls={detailsId} onClick={() => select(port)}>
            <span className="flex items-center gap-2 font-semibold"><Icon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />{item.title}</span>
            {port === "usb" ? <>
              <span className="connection-usb-row"><Zap aria-hidden="true" className="size-4 shrink-0 text-warning-foreground" /><span className="flex min-w-0 flex-col gap-1"><span className="text-muted-foreground">{t("connections.pdPower")}</span><StatusLabel tone={stale ? "idle" : power.tone}>{power.value}</StatusLabel></span></span>
              <span className="connection-usb-row"><Keyboard aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /><span className="flex min-w-0 flex-col gap-1"><span className="text-muted-foreground">{t("overview.usbInput")}</span><StatusLabel tone={tone(port)}>{item.value}</StatusLabel></span></span>
              <span className="text-[11px] text-muted-foreground">{t("connections.powerAndUsbInputShareThis")}</span>
            </> : <>
              {port !== "network" && <span className="text-muted-foreground">{item.label}</span>}
              <StatusLabel tone={tone(port)}>{item.value}</StatusLabel>
              <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{item.detail}</span>
            </>}
          </button>;
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-1 pt-3 text-[11px] text-muted-foreground">
        <div className="flex flex-wrap gap-x-4 gap-y-1"><span className="flex items-center gap-1.5"><i className="h-0.5 w-5 bg-chart-1" />{t("connections.video")}</span><span className="flex items-center gap-1.5"><i className="h-0.5 w-5 bg-chart-2" />{t("trends.network")}</span><span className="flex items-center gap-1.5"><i className="h-0.5 w-5 bg-cyan-600 dark:bg-cyan-400" />{t("connections.usbData")}</span><span className="flex items-center gap-1"><Zap aria-hidden="true" className="size-3.5 text-warning-foreground" />{t("connections.power")}</span></div>
        <span>{t("connections.connectionDiagramDotsIndicateDirectionSelect")}</span>
      </div>
      <div id={detailsId}>
        {selectedData && <div role="region" aria-label={t("connections.details201", { p0: String(selectedData.label) })} className="mt-4 flex flex-wrap items-start gap-3 rounded-lg border bg-muted/30 p-4">
          <selectedData.icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-chart-1" />
          <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1.5">
            <h3 className="text-sm font-semibold">{selectedData.title} · {selectedData.label}</h3>
            <StatusLabel tone={tone(selected!)} className="text-xs">{selectedData.value}</StatusLabel>
            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{selectedData.detail}</p>
            {selected === "usb" && <p className="text-xs text-muted-foreground">{t("connections.theNegotiatedPowerBudgetDoesNot")}</p>}
            <a href={selectedData.href} className="mt-1 inline-flex w-fit items-center gap-1 rounded-sm text-xs text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{selectedData.destination}<ArrowUpRight aria-hidden="true" className="size-3.5" /></a>
          </div>
          <button type="button" aria-label={t("connections.closePortDetails")} className="rounded-md p-1 text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setSelected(undefined)}><X aria-hidden="true" className="size-4" /></button>
        </div>}
      </div>
    </section>
  );
}

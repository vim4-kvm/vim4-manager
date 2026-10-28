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
  unsupported: "当前内核不支持透传", off: "透传已关闭", starting: "正在开启…", stopping: "正在关闭…",
  running: "透传中", "no-signal": "等待输入信号", "no-monitor": "未连接显示器", protected: "输入受版权保护",
  "unsupported-format": "输入格式不支持", "video-error": "输入信号异常",
};

function videoMode(width?: number, height?: number, hz?: number) {
  return width && height ? `${width}×${height}${hz ? ` · ${Number(hz.toFixed(2))} Hz` : ""}` : "分辨率未知";
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
      title: "被控电脑", label: "HDMI IN", icon: Computer, href: "#/video", destination: "视频输入设置",
      value: signal === undefined ? "状态未知" : signal ? "有信号" : "无信号",
      detail: signal ? `${videoMode(input?.width ?? hdmi?.width, input?.height ?? hdmi?.height, input?.refreshHz ?? hdmi?.refreshHz)} · ${input?.hdr || hdrLabel(hdmi?.hdr) || "色彩信息未知"}` : signal === false ? "检查被控电脑与 HDMI 输入线" : "等待输入状态",
      tone: signal === undefined ? "idle" : signal ? "good" : "warning",
    },
    output: {
      title: "本地显示器", label: "HDMI OUT", icon: Monitor, href: "#/output", destination: "HDMI 输出设置",
      value: passthrough ? outputLabels[passthrough.state] : "状态未知",
      detail: passthrough?.monitor ? `${passthrough.monitor.name || "已连接显示器"} · ${passthrough.state === "running" && passthrough.output ? videoMode(passthrough.output.width, passthrough.output.height, passthrough.output.refreshHz) : "显示器已连接"}`
        : passthrough?.state === "off" ? "关闭透传时显示系统控制台" : passthrough?.state === "no-monitor" ? "请连接本地显示器" : "显示器状态未知",
      tone: !passthrough || ["off", "unsupported", "starting", "stopping", "no-monitor"].includes(passthrough.state) ? "idle" : passthrough.state === "running" ? "good" : "warning",
    },
    network: {
      title: "有线网络", label: "网口", icon: Network, href: "#/network", destination: "网络设置",
      value: !ethernet ? "状态未知" : !ethernet.up ? "未连接" : speed ? `已连接 · ${speed >= 1000 ? `${speed / 1000} Gbps` : `${speed} Mbps`}` : "已连接",
      detail: ethernet ? `${ethernet.name} · ${ethernet.addrs?.find((addr) => !addr.includes(":")) || ethernet.addrs?.[0] || "暂无 IP 地址"}` : "未读取到有线网卡",
      tone: ethernet?.up ? "good" : "idle",
    },
    usb: {
      title: "USB-C", label: "供电与键鼠", icon: Usb, href: "#/services", destination: "底层服务",
      value: usb === "configured" ? "键鼠已连接" : !usb ? "键鼠状态未知" : "等待键鼠连接",
      detail: `${power.value} · ${power.detail}`, tone: usb === "configured" ? "good" : "idle",
    },
  };
}

/** Port positions are normalized to the unrotated Khadas VIM4 top-view photo. */
const ports: { id: Port; x: number; y: number; label: string }[] = [
  { id: "network", x: 31, y: 5, label: "网口" },
  { id: "output", x: 53, y: 5, label: "HDMI OUT" },
  { id: "usb", x: 70.5, y: 5, label: "USB-C" },
  { id: "input", x: 16, y: 94, label: "HDMI IN" },
];

export function DeviceConnections({ status, passthrough = status?.passthrough, stale = false }: {
  status?: Status; passthrough?: PassthroughState; stale?: boolean;
}) {
  const [selected, setSelected] = useState<Port>();
  const detailsId = useId();
  const mapRef = useRef<HTMLDivElement>(null);
  const data = connections(status, passthrough);
  const power = powerConnection(status?.power);
  const tone = (port: Port) => stale ? "idle" : data[port].tone;
  const selectedData = selected ? data[selected] : undefined;
  const select = (port: Port) => setSelected((current) => current === port ? undefined : port);
  return (
    <section aria-label="设备连线图" className="device-connections">
      {stale && <p role="status" className="mb-3 text-xs text-warning-foreground">连接中断 · 以下为上次读取的状态</p>}
      <div className="connection-map" ref={mapRef}>
        <ConnectionLines mapRef={mapRef} tones={{ network: tone("network"), usb: tone("usb"), input: tone("input"), output: tone("output") }} />
        <div className="connection-board">
          <img src={boardImage} alt="Khadas New VIM4 板卡俯视图" width={1995} height={1414} className="block h-auto w-full" />
          {ports.map((port) => <button key={port.id} type="button" className="connection-port" style={{ left: `${port.x}%`, top: `${port.y}%` }}
            data-port={port.id} data-tone={tone(port.id)} data-selected={selected === port.id} aria-label={`${port.label} 接口`} aria-pressed={selected === port.id} aria-controls={detailsId}
            title={`${port.label} · ${data[port.id].value}`} onClick={() => select(port.id)}>
            <span className="connection-port-dot" /><span className={cn("connection-port-label", port.id === "input" && "connection-port-label-bottom")}>{port.label}</span>
          </button>)}
        </div>
        {(["network", "usb", "input", "output"] as const).map((port) => {
          const item = data[port];
          const Icon = item.icon;
          return <button key={port} type="button" className={`connection-endpoint connection-endpoint-${port}`} data-selected={selected === port}
            aria-label={`${item.title} · ${item.label}详情`} aria-pressed={selected === port} aria-controls={detailsId} onClick={() => select(port)}>
            <span className="flex items-center gap-2 font-semibold"><Icon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />{item.title}</span>
            {port === "usb" ? <>
              <span className="connection-usb-row"><Zap aria-hidden="true" className="size-4 shrink-0 text-warning-foreground" /><span className="flex min-w-0 flex-col gap-1"><span className="text-muted-foreground">PD 供电</span><StatusLabel tone={stale ? "idle" : power.tone}>{power.value}</StatusLabel></span></span>
              <span className="connection-usb-row"><Keyboard aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /><span className="flex min-w-0 flex-col gap-1"><span className="text-muted-foreground">USB 键鼠</span><StatusLabel tone={tone(port)}>{item.value}</StatusLabel></span></span>
              <span className="text-[11px] text-muted-foreground">供电与键鼠共用此接口</span>
            </> : <>
              {port !== "network" && <span className="text-muted-foreground">{item.label}</span>}
              <StatusLabel tone={tone(port)}>{item.value}</StatusLabel>
              <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{item.detail}</span>
            </>}
          </button>;
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-1 pt-3 text-[11px] text-muted-foreground">
        <div className="flex flex-wrap gap-x-4 gap-y-1"><span className="flex items-center gap-1.5"><i className="h-0.5 w-5 bg-chart-1" />视频</span><span className="flex items-center gap-1.5"><i className="h-0.5 w-5 bg-chart-2" />网络</span><span className="flex items-center gap-1.5"><i className="h-0.5 w-5 bg-cyan-600 dark:bg-cyan-400" />USB 数据</span><span className="flex items-center gap-1"><Zap aria-hidden="true" className="size-3.5 text-warning-foreground" />供电</span></div>
        <span>逻辑连接示意 · 光点示意流向 · 点击接口查看详情</span>
      </div>
      <div id={detailsId}>
        {selectedData && <div role="region" aria-label={`${selectedData.label}详情`} className="mt-4 flex flex-wrap items-start gap-3 rounded-lg border bg-muted/30 p-4">
          <selectedData.icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-chart-1" />
          <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1.5">
            <h3 className="text-sm font-semibold">{selectedData.title} · {selectedData.label}</h3>
            <StatusLabel tone={tone(selected!)} className="text-xs">{selectedData.value}</StatusLabel>
            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{selectedData.detail}</p>
            {selected === "usb" && <p className="text-xs text-muted-foreground">协商额度不代表实时电流或功耗；键鼠状态以 USB 枚举为准。</p>}
            <a href={selectedData.href} className="mt-1 inline-flex w-fit items-center gap-1 rounded-sm text-xs text-chart-1 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{selectedData.destination}<ArrowUpRight aria-hidden="true" className="size-3.5" /></a>
          </div>
          <button type="button" aria-label="关闭接口详情" className="rounded-md p-1 text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setSelected(undefined)}><X aria-hidden="true" className="size-4" /></button>
        </div>}
      </div>
    </section>
  );
}

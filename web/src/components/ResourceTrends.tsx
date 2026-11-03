import { number } from "@/i18n/format";
import { t, useLocale } from "@/i18n";
import { NativeSelect } from "@/components/ui/native-select";
import { useLayoutEffect, useRef, useState } from "react";
import { Tabs } from "radix-ui";
import type { Hardware, Sample } from "@/api";
import { TrendChart, useWidth, type Point } from "@/components/TrendChart";
import { celsius } from "@/lib/units";
import { cn } from "@/lib/utils";

const metrics = [
  { id: "cpu", title: "CPU" }, { id: "gpu", title: "GPU" }, { id: "mem", get title() { return t("overview.memory"); } }, { id: "network", get title() { return t("trends.network"); } },
  { id: "temp", get title() { return t("trends.temperature"); } }, { id: "fan", get title() { return t("overview.fan"); } }, { id: "power", get title() { return t("trends.power"); } },
] as const;
type Metric = typeof metrics[number]["id"];
type Series = {
  label: string; value: string; detail: string; points: Point[];
  domain: [number, number]; ticks: number[]; format: (value: number) => string;
  tickFormat?: (value: number) => string;
  compare?: { label: string; points: Point[] };
  currentAvailable?: boolean; emptyMessage?: string; maxGapMs?: number;
};
const percent = (value: number) => `${Math.round(value)}%`;
const watts = (value: number) => `${number(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} W`;

function bitrate(bps: number): string {
  if (bps >= 1e9) return `${number(bps / 1e9, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Gbps`;
  if (bps >= 1e6) return `${number(bps / 1e6, { minimumFractionDigits: bps >= 1e8 ? 0 : 1, maximumFractionDigits: bps >= 1e8 ? 0 : 1 })} Mbps`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} kbps`;
  return `${Math.round(bps)} bps`;
}

/** Round the peak to a short, evenly spaced axis without excessive headroom. */
function resourceScale(points: Point[], percentage = false) {
  const peak = Math.max(0, ...points.map((p) => p.v));
  const magnitude = 10 ** Math.floor(Math.log10(peak > 0 ? peak / 3 : 1));
  const step = [1, 2, 2.5, 5, 10].map((n) => n * magnitude).find((n) => n >= peak / 3)!;
  // Round away float residue (3 × 0.2) so the top tick is not drawn twice.
  const upper = Math.min(percentage ? 100 : Infinity, +(Math.ceil(peak / step || 1) * step).toPrecision(12));
  const ticks = Array.from({ length: Math.ceil(+(upper / step).toPrecision(12)) + 1 }, (_, i) => Math.min(upper, +(i * step).toPrecision(12)));
  return { domain: [0, upper] as [number, number], ticks };
}

function percentageScale(points: Point[]) {
  return { ...resourceScale(points, true), tickFormat: (value: number) => `${number(value, { maximumFractionDigits: 2 })}%` };
}

/** One visible resource chart; every tab uses the same board history and time window. */
export function ResourceTrends({ hw, history, now }: { hw: Hardware; history: Sample[]; now: number }) {
 const locale = useLocale();
  const [chartRef, chartWidth] = useWidth<HTMLElement>();
  const tabs = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = () => {
    const el = tabs.current;
    if (el) setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
  };
  const [metric, setMetric] = useState<Metric>("cpu");
  const switched = useRef(false);
  // One highlight slides between tabs; its first placement and reduced motion jump straight there.
  const [indicator, setIndicator] = useState<{ x: number; width: number; slide: boolean }>();
  const placeIndicator = () => {
    const active = tabs.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    if (active) setIndicator((current) => ({ x: active.offsetLeft, width: active.offsetWidth, slide: current !== undefined }));
  };
  useLayoutEffect(() => {
    const el = tabs.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    if (active) {
      if (active.offsetLeft < el.scrollLeft) el.scrollLeft = active.offsetLeft;
      else if (active.offsetLeft + active.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = active.offsetLeft + active.offsetWidth - el.clientWidth;
    }
    const observer = new ResizeObserver(() => { updateEdges(); placeIndicator(); });
    observer.observe(el);
    updateEdges();
    placeIndicator();
    return () => observer.disconnect();
  }, [metric, locale]);
  const [windowMinutes, setWindowMinutes] = useState(15);
  const [hover, setHover] = useState<number>();
  const end = Math.max(now, history.at(-1)?.t ?? 0);
  const samples = history.filter((sample) => sample.t >= end - windowMinutes * 60000);
  const series = (pick: (sample: Sample) => number): Point[] => samples.map((sample) => ({ t: sample.t, v: pick(sample) }));
  const cpu = series((s) => s.cpu);
  const gpu = samples.flatMap((s) => s.gpu == null ? [] : [{ t: s.t, v: s.gpu }]);
  const mem = series((s) => s.mem);
  const temp = series((s) => s.tempC);
  const fan = series((s) => s.fan);
  const tx = series((s) => s.txBps);
  const rx = series((s) => s.rxBps);
  const power = samples.flatMap((s) => s.cpuPowerW == null ? [] : [{ t: s.t, v: s.cpuPowerW }]);
  const latest = samples.at(-1);
  const networkScale = resourceScale([...tx, ...rx]);
  const powerScale = resourceScale(power);
  const temperatureScale = resourceScale(temp);
  const memUsed = hw.memTotalKiB ? 1 - hw.memAvailableKiB / hw.memTotalKiB : undefined;
  const definitions: Record<Metric, Series> = {
    cpu: { label: t("trends.cpuUsage"), value: latest ? percent(latest.cpu) : "—", detail: t("trends.coresLoad", { count: hw.cpus, p1: String(number(hw.load1, { minimumFractionDigits: 2, maximumFractionDigits: 2 })) }),
      points: cpu, ...percentageScale(cpu), format: percent },
    gpu: { label: t("trends.gpuUsage"), value: latest?.gpu == null ? "—" : percent(latest.gpu),
      detail: latest?.gpu == null ? t("trends.waitingForGpuSamplesOrThe") : t("trends.maliGpuBusyTimeDuringThe"),
      points: gpu, ...percentageScale(gpu), format: percent, maxGapMs: 7500,
      currentAvailable: latest?.gpu != null, emptyMessage: latest ? t("trends.noGpuData") : t("trends.sampling") },
    mem: { label: t("trends.memoryUsage"), value: memUsed === undefined ? "—" : percent(memUsed * 100),
      detail: t("trends.ofGibAvailable", { p0: String(number(hw.memAvailableKiB / 1048576, { minimumFractionDigits: 1, maximumFractionDigits: 1 })), p1: String(number(hw.memTotalKiB / 1048576, { minimumFractionDigits: 1, maximumFractionDigits: 1 })) }),
      points: mem, ...percentageScale(mem), format: percent },
    network: { label: t("trends.networkUpload"), value: latest ? bitrate(latest.txBps) : "—", detail: latest ? t("trends.downloadAllNetworkAdaptersMostlyVideo", { p0: String(bitrate(latest.rxBps)) }) : t("trends.waitingForNetworkSamples"),
      points: tx, compare: { label: t("trends.download"), points: rx }, ...networkScale, format: bitrate,
      tickFormat: (value) => value >= 1e9 ? `${number(value / 1e9, { maximumFractionDigits: 1 })}G` : value >= 1e6 ? `${number(value / 1e6, { maximumFractionDigits: 1 })}M` : value >= 1e3 ? `${number(value / 1e3, { maximumFractionDigits: 1 })}k` : number(value, { maximumFractionDigits: 1 }) },
    temp: { label: t("overview.socTemperature"), value: celsius(hw.tempC), detail: t("trends.boardTemperatureSensorDoesNotMeasure"),
      points: temp, ...temperatureScale, format: celsius },
    fan: { label: t("trends.fanDuty"), value: hw.fanPercent > 0 ? percent(hw.fanPercent) : t("overview.stopped"), detail: t("trends.controlDutyCycleNotRpm", { p0: String(hw.fanAuto ? t("overview.auto") : t("overview.manual")) }),
      points: fan, ...percentageScale(fan), format: percent },
    power: { label: t("trends.cpuDynamicPowerEstimated"), value: latest?.cpuPowerW == null ? "—" : watts(latest.cpuPowerW),
      detail: latest?.cpuPowerAvailable === false ? t("trends.powerModelOrCountersUnavailable") : latest?.cpuPowerW == null ? t("trends.twoConsecutiveValidSamplesRequired") : t("trends.estimatedFromFrequencyResidencyAndPer"),
      points: power, ...powerScale, format: watts, maxGapMs: 7500,
      currentAvailable: latest?.cpuPowerW != null, emptyMessage: latest?.cpuPowerAvailable === false ? t("trends.estimateUnavailable") : t("trends.sampling") },
  };
  const selected = definitions[metric];
  const values = selected.points.map((p) => p.v);
  const average = values.length ? selected.format(values.reduce((sum, value) => sum + value, 0) / values.length) : "—";
  const peak = values.length ? selected.format(Math.max(...values)) : "—";
  const span = samples.length ? samples.at(-1)!.t - samples[0].t : 0;
  const partial = span < (windowMinutes - 0.5) * 60000;
  const minutes = samples.length ? partial ? Math.max(1, Math.floor(span / 60000)) : windowMinutes : 0;
  return (
    <section ref={chartRef} aria-labelledby="resource-trends" data-trends className="h-full min-w-0 rounded-xl border bg-card p-4 shadow-xs @lg:p-5">
      <Tabs.Root value={metric} onValueChange={(value) => { switched.current = true; setMetric(value as Metric); setHover(undefined); }}>
        <div className="mb-4 grid grid-cols-[1fr_auto] items-center gap-3 @4xl:grid-cols-[auto_minmax(0,1fr)_auto]">
          <h2 id="resource-trends" className="text-base font-medium ">{t("trends.resourceTrends")}</h2>
          <NativeSelect className="@4xl:col-start-3" size="sm" aria-label={t("trends.trendTimeRange")} value={windowMinutes} onChange={(event) => { setWindowMinutes(Number(event.target.value)); setHover(undefined); }}>
            <option value={15}>{t("trends.lastMinutes")}</option><option value={5}>{t("trends.lastMinutes143")}</option>
          </NativeSelect>
        <Tabs.List ref={tabs} onScroll={updateEdges} aria-label={t("trends.resourceMetrics")} className="relative col-span-2 row-start-2 flex w-fit max-w-full @4xl:col-span-1 @4xl:col-start-2 @4xl:row-start-1 snap-x gap-0.5 overflow-x-auto rounded-md bg-muted p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{ maskImage: `linear-gradient(to right, ${edges.left ? "transparent, black 12px" : "black, black"}, ${edges.right ? "black calc(100% - 12px), transparent" : "black, black"})` }}>
          {indicator && <span aria-hidden data-tab-indicator style={{ translate: `${indicator.x}px`, width: indicator.width }}
            className={cn("absolute inset-y-1 left-0 rounded-sm bg-card shadow-xs", indicator.slide && "transition-[translate,width] duration-280 ease-(--ease-default) motion-reduce:transition-none")} />}
          {metrics.map((item) => <Tabs.Trigger key={item.id} value={item.id}
            className="relative snap-start shrink-0 rounded-sm px-2.5 py-1.5 text-xs font-medium text-muted-foreground outline-none transition-colors duration-200 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=active]:text-foreground">{item.title}</Tabs.Trigger>)}
        </Tabs.List>
        </div>
        <Tabs.Content value={metric} className="outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <figure>
            {/* Only the readings fade; the chart stays mounted so its measured width never collapses. */}
            <figcaption key={metric} className={cn("mb-4 flex flex-col gap-4 @4xl:flex-row @4xl:items-center @4xl:justify-between",
              switched.current && "animate-in fade-in-0 duration-200 motion-reduce:animate-none")}>
            <div className="flex min-w-0 flex-col gap-1">
              <span data-trend-title className="text-xs text-muted-foreground">{selected.label}</span>
              <span data-trend-value className="text-3xl font-medium  tabular-nums">{selected.value}</span>
              <span data-trend-detail className="min-h-[2lh] text-xs text-muted-foreground @4xl:min-h-0">{selected.detail}</span>
            </div>
            <dl className="grid shrink-0 grid-cols-3 gap-4 text-xs @4xl:text-right">
              {[{ label: t("trends.average"), value: average }, { label: t("trends.peak"), value: peak },
                { label: t("trends.minimum"), value: values.length ? selected.format(Math.min(...values)) : "—" }].map((stat, index) => (
                  <div key={stat.label} className={index ? "min-w-0 pl-4" : "min-w-0"}><dt className="text-muted-foreground">{stat.label}</dt><dd className="mt-1 font-medium tabular-nums">{stat.value}</dd></div>
                ))}
            </dl>
            </figcaption>
            <TrendChart {...selected} morphKey={`${metric}-${windowMinutes}`} end={end} windowMs={windowMinutes * 60000} height={chartWidth >= 600 ? 240 : 180}
              hover={hover} onHover={setHover} sampledFrom={samples[0]?.t} sampledMinutes={minutes || windowMinutes} />

          </figure>
        </Tabs.Content>
      </Tabs.Root>
      <p className="mt-3 text-xs text-muted-foreground">{t("trends.sampledEverySeconds")}{partial && samples.length > 0 ? t("trends.minutesSampled", { count: minutes }) : ""} {t("trends.resetsWhenTheManagerRestarts")}</p>
    </section>
  );
}

import { NativeSelect } from "@/components/ui/native-select";
import { useState } from "react";
import { Tabs } from "radix-ui";
import type { Hardware, Sample } from "@/api";
import { TrendChart, tempDomain, type Point } from "@/components/TrendChart";
import { celsius } from "@/lib/units";

const metrics = [
  { id: "cpu", title: "CPU" }, { id: "gpu", title: "GPU" }, { id: "mem", title: "内存" }, { id: "network", title: "网络" },
  { id: "temp", title: "温度" }, { id: "fan", title: "风扇" }, { id: "power", title: "功耗" },
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
const watts = (value: number) => `${value.toFixed(2)} W`;

function bitrate(bps: number): string {
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} Gbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1)} Mbps`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} kbps`;
  return `${Math.round(bps)} bps`;
}

function niceCeil(value: number): number {
  const step = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].map((multiple) => multiple * step).find((upper) => upper >= value)!;
}

function percentageScale(points: Point[]) {
  const upper = [25, 50, 100].find((limit) => limit >= Math.max(0, ...points.map((p) => p.v)) * 1.2) ?? 100;
  return { domain: [0, upper] as [number, number], ticks: [0, upper / 2, upper], tickFormat: (value: number) => `${value}%` };
}

/** One visible resource chart; every tab uses the same board history and time window. */
export function ResourceTrends({ hw, history, now }: { hw: Hardware; history: Sample[]; now: number }) {
  const [metric, setMetric] = useState<Metric>("cpu");
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
  const netMax = niceCeil(Math.max(1e6, ...tx.map((p) => p.v), ...rx.map((p) => p.v)));
  const powerMax = niceCeil(Math.max(1, ...power.map((p) => p.v)));
  const temperatureRange = tempDomain(temp.map((p) => p.v));
  const memUsed = hw.memTotalKiB ? 1 - hw.memAvailableKiB / hw.memTotalKiB : undefined;
  const definitions: Record<Metric, Series> = {
    cpu: { label: "CPU 使用率", value: latest ? percent(latest.cpu) : "—", detail: `${hw.cpus} 核 · 当前负载 ${hw.load1.toFixed(2)}`,
      points: cpu, ...percentageScale(cpu), format: percent },
    gpu: { label: "GPU 使用率", value: latest?.gpu == null ? "—" : percent(latest.gpu),
      detail: latest?.gpu == null ? "等待 GPU 采样或当前驱动未提供读数" : "Mali GPU · 驱动最近采样周期的忙碌比例",
      points: gpu, ...percentageScale(gpu), format: percent, maxGapMs: 7500,
      currentAvailable: latest?.gpu != null, emptyMessage: latest ? "暂无 GPU 数据" : "正在采样…" },
    mem: { label: "内存占用", value: memUsed === undefined ? "—" : percent(memUsed * 100),
      detail: `可用 ${(hw.memAvailableKiB / 1048576).toFixed(1)} / ${(hw.memTotalKiB / 1048576).toFixed(1)} GiB`,
      points: mem, ...percentageScale(mem), format: percent },
    network: { label: "网络发送", value: latest ? bitrate(latest.txBps) : "—", detail: latest ? `接收 ${bitrate(latest.rxBps)} · 所有网卡合计，主要为视频流量` : "等待网络采样",
      points: tx, compare: { label: "接收", points: rx }, domain: [0, netMax], ticks: [0, netMax / 2, netMax], format: bitrate,
      tickFormat: (value) => value === 0 ? "0" : value >= 1e9 ? `${+(value / 1e9).toFixed(1)}G` : `${+(value / 1e6).toFixed(1)}M` },
    temp: { label: "SoC 温度", value: celsius(hw.tempC), detail: "板载温度传感器 · 不代表 HDMI 输入设备温度",
      points: temp, domain: temperatureRange, ticks: [temperatureRange[0], (temperatureRange[0] + temperatureRange[1]) / 2, temperatureRange[1]], format: celsius },
    fan: { label: "风扇占空比", value: hw.fanPercent > 0 ? percent(hw.fanPercent) : "停转", detail: `${hw.fanAuto ? "自动" : "手动"}调速 · 占空比，不代表转速`,
      points: fan, ...percentageScale(fan), format: percent },
    power: { label: "CPU 动态功耗（估算）", value: latest?.cpuPowerW == null ? "—" : watts(latest.cpuPowerW),
      detail: latest?.cpuPowerAvailable === false ? "功耗模型或计数器不可用" : latest?.cpuPowerW == null ? "需要连续两次有效采样" : "按频率驻留与各核利用率估算 · 不含静态功耗",
      points: power, domain: [0, powerMax], ticks: [0, powerMax / 2, powerMax], format: watts, maxGapMs: 7500,
      currentAvailable: latest?.cpuPowerW != null, emptyMessage: latest?.cpuPowerAvailable === false ? "暂无法估算" : "正在采样…" },
  };
  const selected = definitions[metric];
  const values = selected.points.map((p) => p.v);
  const average = values.length ? selected.format(values.reduce((sum, value) => sum + value, 0) / values.length) : "—";
  const peak = values.length ? selected.format(Math.max(...values)) : "—";
  const span = samples.length ? samples.at(-1)!.t - samples[0].t : 0;
  const partial = span < (windowMinutes - 0.5) * 60000;
  const minutes = samples.length ? partial ? Math.max(1, Math.floor(span / 60000)) : windowMinutes : 0;
  return (
    <section aria-labelledby="resource-trends" data-trends className="h-full min-w-0 rounded-xl border bg-card p-4 shadow-xs @lg:p-5">
      <Tabs.Root value={metric} onValueChange={(value) => { setMetric(value as Metric); setHover(undefined); }}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 id="resource-trends" className="text-base font-semibold tracking-tight">资源趋势</h2>
          <NativeSelect size="sm" aria-label="趋势时间范围" value={windowMinutes} onChange={(event) => { setWindowMinutes(Number(event.target.value)); setHover(undefined); }}>
            <option value={15}>最近 15 分钟</option><option value={5}>最近 5 分钟</option>
          </NativeSelect>
        </div>
        <Tabs.List aria-label="资源指标" className="mb-4 flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-md bg-muted p-1 [scrollbar-width:none]">
          {metrics.map((item) => <Tabs.Trigger key={item.id} value={item.id}
            className="shrink-0 rounded-sm px-2.5 py-1.5 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-xs">{item.title}</Tabs.Trigger>)}
        </Tabs.List>
        <Tabs.Content key={metric} value={metric} className="outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <figure>
            <figcaption className="mb-3 flex flex-col gap-1">
              <span data-trend-title className="text-xs text-muted-foreground">{selected.label}</span>
              <span data-trend-value className="text-3xl font-semibold tracking-tight tabular-nums">{selected.value}</span>
              <span data-trend-detail className="text-xs text-muted-foreground">{selected.detail}</span>
            </figcaption>
            <TrendChart {...selected} key={`${metric}-${windowMinutes}`} end={end} windowMs={windowMinutes * 60000} height={128}
              hover={hover} onHover={setHover} sampledFrom={samples[0]?.t} sampledMinutes={minutes || windowMinutes} />
            <dl className="mt-4 grid grid-cols-3 divide-x border-t pt-3 text-xs">
              {[{ label: "平均", value: average }, { label: "峰值", value: peak },
                { label: "最低", value: values.length ? selected.format(Math.min(...values)) : "—" }].map((stat, index) => (
                  <div key={stat.label} className={index ? "min-w-0 pl-4" : "min-w-0"}><dt className="text-muted-foreground">{stat.label}</dt><dd className="mt-1 font-semibold tabular-nums">{stat.value}</dd></div>
                ))}
            </dl>
          </figure>
        </Tabs.Content>
      </Tabs.Root>
      <p className="mt-3 text-[11px] text-muted-foreground">每 5 秒采样{partial && samples.length > 0 ? ` · 已采样 ${minutes} 分钟` : ""} · 管理服务重启后重新开始</p>
    </section>
  );
}

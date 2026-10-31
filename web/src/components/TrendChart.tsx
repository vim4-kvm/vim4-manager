import { t, useLocale, getLocale } from "@/i18n";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { animate, useReducedMotion } from "motion/react";
import { enter } from "@/lib/motion";
import { cn } from "@/lib/utils";

const TICK = "fill-muted-foreground text-xs tabular-nums";
const LINE = "fill-none [stroke-linecap:round] [stroke-linejoin:round]";
const DOT = "fill-chart-1 stroke-card stroke-3";

const AXIS = 20;
// Room on the left for y tick labels and on the right for the end dot ring.
const PAD_LEFT = 36;
const PAD_RIGHT = 8;
const PAD_TOP = 8;

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function clock(t: number): string {
  return new Date(t).toLocaleTimeString(getLocale(), { hourCycle: "h23" });
}

export interface Point {
  t: number;
  v: number;
}

type Placed = { t: number; x: number; y: number };
type Frame = { line: Placed[]; other: Placed[] };

/** Position of a painted line at time t, held flat beyond its ends. */
function placeAt(line: Placed[], t: number): Placed {
  if (t <= line[0].t) return line[0];
  const i = line.findIndex((p) => p.t >= t);
  if (i < 0) return line[line.length - 1];
  const a = line[i - 1], b = line[i], k = (t - a.t) / (b.t - a.t);
  return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

/** Ease every point from where the previous series drew that time to its target. */
function tween(from: Placed[], to: Placed[], k: number): Placed[] {
  if (!from.length) return to;
  return to.map((p) => {
    const start = placeAt(from, p.t);
    return { t: p.t, x: start.x + (p.x - start.x) * k, y: start.y + (p.y - start.y) * k };
  });
}

/** Use the same rounded history duration in captions and accessible summaries. */
export function samplingWindow(first?: number, last?: number) {
  const span = (last ?? 0) - (first ?? 0);
  const partial = span < 14.5 * 60000;
  return { partial, minutes: partial ? Math.max(1, Math.floor(span / 60000)) : 15 };
}

/**
 * One series over the trailing window. Charts in the same group share the
 * hovered time so their crosshairs move together.
 */
export function TrendChart({
  label,
  points,
  compare,
  end,
  windowMs,
  domain,
  ticks,
  format,
  tickFormat,
  hover,
  onHover,
  maxGapMs = Infinity,
  currentAvailable = true,
  emptyMessage = t("chart.noSamplesYet"),
  height = 112,
  sampledFrom,
  sampledMinutes = Math.round(windowMs / 60000),
  morphKey,
}: {
  label: string;
  points: Point[];
  /** A second series on the same axis, drawn muted; sampled at the same times. */
  compare?: { label: string; points: Point[] };
  end: number;
  windowMs: number;
  domain: [number, number];
  ticks: number[];
  format: (v: number) => string;
  tickFormat?: (v: number) => string;
  hover?: number;
  onHover: (t?: number) => void;
  /** Do not connect across unavailable sampling intervals. */
  maxGapMs?: number;
  currentAvailable?: boolean;
  emptyMessage?: string;
  height?: number;
  /** History start, including samples whose value is unavailable for this series. */
  sampledFrom?: number;
  sampledMinutes?: number;
  /** Changing this eases the lines from the previous series instead of redrawing them. */
  morphKey?: string;
}) {
 useLocale();
  const [ref, width] = useWidth<HTMLDivElement>();
  const gradientId = useId();
  const plotW = Math.max(0, width - PAD_LEFT - PAD_RIGHT);
  const start = end - windowMs;
  const x = (t: number) => PAD_LEFT + ((t - start) / windowMs) * plotW;
  const y = (v: number) => PAD_TOP + (1 - (Math.min(domain[1], Math.max(domain[0], v)) - domain[0]) / (domain[1] - domain[0])) * height;
  const firstSample = sampledFrom ?? points[0]?.t;
  const unsampledWidth = firstSample !== undefined && firstSample - start > 10000
    ? Math.min(plotW, x(firstSample) - PAD_LEFT) : 0;
  const visible = points.filter((p) => p.t >= start);
  const last = visible[visible.length - 1];
  const other = compare?.points.filter((p) => p.t >= start) ?? [];

  const reduced = useReducedMotion();
  const [morph, setMorph] = useState<{ from: Frame; k: number }>();
  const painted = useRef<Frame>(undefined);
  const morphed = useRef(morphKey);
  // Runs before the frame is painted, so the new series never flashes at its final shape.
  useLayoutEffect(() => {
    if (morphed.current === morphKey) return;
    morphed.current = morphKey;
    const from = painted.current;
    if (reduced || !from?.line.length) return;
    setMorph({ from, k: 0 });
    const controls = animate(0, 1, { ...enter("slow"), onUpdate: (k) => setMorph({ from, k }), onComplete: () => setMorph(undefined) });
    return () => { controls.stop(); setMorph(undefined); };
  }, [morphKey]);
  const place = (p: Point): Placed => ({ t: p.t, x: x(p.t), y: y(p.v) });
  const frame: Frame = { line: visible.map(place), other: other.map(place) };
  if (morph) {
    frame.line = tween(morph.from.line, frame.line, morph.k);
    frame.other = tween(morph.from.other.length ? morph.from.other : morph.from.line, frame.other, morph.k);
  }
  useLayoutEffect(() => { painted.current = frame; });

  const segments: Placed[][] = [];
  for (const point of frame.line) {
    const segment = segments.at(-1);
    if (!segment || point.t - segment[segment.length - 1].t > maxGapMs) segments.push([point]);
    else segment.push(point);
  }
  const path = (segment: Placed[]) => segment.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("");
  const line = segments.map(path).join("");
  const area = segments.filter((segment) => segment.length > 1).map((segment) =>
    `${path(segment)}L${segment[segment.length - 1].x.toFixed(1)},${PAD_TOP + height}L${segment[0].x.toFixed(1)},${PAD_TOP + height}Z`).join("");
  const otherLine = path(frame.other);
  const head = frame.line[frame.line.length - 1];

  const nearest = (t: number) =>
    visible.reduce<Point | undefined>((best, p) => (!best || Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best), undefined);
  const active = hover === undefined ? undefined : nearest(hover);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipLeft, setTooltipLeft] = useState(0);
  useLayoutEffect(() => {
    if (!active) return;
    const tip = tooltipRef.current?.getBoundingClientRect();
    if (!tip) return;
    const anchor = PAD_LEFT + ((active.t - start) / windowMs) * plotW;
    const preferred = anchor + (anchor > width / 2 ? -tip.width - 8 : 8);
    // Measure the full tooltip, including the optional receive rate, before clamping.
    setTooltipLeft(Math.max(0, Math.min(preferred, width - tip.width)));
  }, [active?.t, width, start, windowMs, plotW]);

  const move = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const t = start + ((e.clientX - box.left - PAD_LEFT) / plotW) * windowMs;
    onHover(nearest(t)?.t);
  };
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    ref.current?.scrollIntoView({ block: "nearest" });
    const index = active ? visible.indexOf(active) : visible.length;
    const next = visible[Math.min(visible.length - 1, Math.max(0, index + (e.key === "ArrowLeft" ? -1 : 1)))];
    onHover(next?.t);
  };

  const values = visible.map((p) => p.v);
  const summary = visible.length
    ? t("chart.lastMinutesCurrentMinimumMaximum", { p0: String(label), count: sampledMinutes, p2: String(currentAvailable ? format(last.v) : t("chart.noData")), p3: String(format(Math.min(...values))), p4: String(format(Math.max(...values))) })
    : `${label}：${emptyMessage}`;

  const minutes = Math.round(windowMs / 60000);
  // Narrow plots keep only the ends so the time labels never overlap.
  const xTicks = plotW < 260 ? [minutes, 0] : [minutes, (minutes * 2) / 3, minutes / 3, 0];

  return (
    <div className="relative min-w-0" ref={ref} onPointerLeave={() => onHover(undefined)}>
      {width > 0 && (
        <svg
          width={width}
          height={PAD_TOP + height + AXIS}
          role="img"
          aria-label={summary}
          tabIndex={0}
          className="block touch-pan-y overflow-visible rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          onPointerMove={move}
          onBlur={() => onHover(undefined)}
          onKeyDown={key}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity=".18" />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {unsampledWidth > 0 && <rect data-chart="unsampled" className="fill-muted" x={PAD_LEFT} y={PAD_TOP} width={unsampledWidth} height={height} />}
          <g key={morphKey} className={cn(morph && "animate-in fade-in-0 duration-280")}>
            {ticks.map((v) => (
              <g key={v}>
                <line data-chart="grid" className="stroke-border [shape-rendering:crispEdges]" x1={PAD_LEFT} x2={PAD_LEFT + plotW} y1={y(v)} y2={y(v)} />
                <text data-chart="tick" className={TICK} x={PAD_LEFT - 6} y={y(v)} textAnchor="end" dominantBaseline="middle">
                  {tickFormat ? tickFormat(v) : v}
                </text>
              </g>
            ))}
          </g>
          {xTicks.map((m) => (
            <text
              key={m}
              data-chart="tick"
              className={TICK}
              x={x(end - m * 60000)}
              y={PAD_TOP + height + 14}
              textAnchor={m === 0 ? "end" : m === minutes ? "start" : "middle"}
            >
              {m === 0 ? t("chart.now") : new Intl.DateTimeFormat(getLocale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(end - m * 60000)}
            </text>
          ))}
          <path fill={`url(#${gradientId})`} d={area} />
          {otherLine && <path data-chart="line-compare" className={cn(LINE, "stroke-chart-2 stroke-[1.25]")} d={otherLine} />}
          <path data-chart="line" className={cn(LINE, "stroke-chart-1 stroke-[1.75]")} d={line} />
          {active && (
            <>
              <line data-chart="crosshair" className="stroke-muted-foreground [stroke-dasharray:2_3] [shape-rendering:crispEdges]" x1={x(active.t)} x2={x(active.t)} y1={PAD_TOP} y2={PAD_TOP + height} />
              <circle data-chart="dot" className={DOT} cx={x(active.t)} cy={y(active.v)} r={4} />
            </>
          )}
          {!active && head && currentAvailable && <circle data-chart="dot" className={DOT} cx={head.x} cy={head.y} r={4} />}
        </svg>
      )}
      {active && width > 0 && (
        <div
          data-chart="tooltip"
          className="absolute z-10 flex w-max max-w-full flex-wrap items-baseline gap-x-2 rounded-md border bg-popover px-2 py-0.5 text-xs text-popover-foreground tabular-nums shadow-md animate-in fade-in-0 duration-100 [&>span]:text-muted-foreground"
          ref={tooltipRef}
          style={{ left: tooltipLeft, top: PAD_TOP }}
        >
          <strong className="font-medium">{format(active.v)}</strong>
          {compare && (
            <span>
              {compare.label} {format(other.find((p) => p.t === active.t)?.v ?? 0)}
            </span>
          )}
          <span>{clock(active.t)}</span>
        </div>
      )}
      {!visible.length && <div data-chart="empty" className="absolute inset-[0_0_20px_30px] grid place-items-center text-xs text-muted-foreground">{emptyMessage}</div>}
    </div>
  );
}

/** Rounds a temperature range out to a 10 °C grid that keeps 20 °C of span. */
export function tempDomain(values: number[]): [number, number] {
  if (!values.length) return [30, 70];
  const lo = Math.floor((Math.min(...values) - 3) / 10) * 10;
  const hi = Math.ceil((Math.max(...values) + 3) / 10) * 10;
  return [lo, Math.max(hi, lo + 20)];
}

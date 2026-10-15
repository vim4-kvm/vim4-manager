import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const HEIGHT = 112;
const AXIS = 20;
// Room on the left for y tick labels and on the right for the end dot ring.
const PAD_LEFT = 30;
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
  return new Date(t).toLocaleTimeString("zh-CN", { hour12: false });
}

export interface Point {
  t: number;
  v: number;
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
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const plotW = Math.max(0, width - PAD_LEFT - PAD_RIGHT);
  const start = end - windowMs;
  const x = (t: number) => PAD_LEFT + ((t - start) / windowMs) * plotW;
  const y = (v: number) => PAD_TOP + (1 - (Math.min(domain[1], Math.max(domain[0], v)) - domain[0]) / (domain[1] - domain[0])) * HEIGHT;
  const visible = points.filter((p) => p.t >= start);
  const line = visible.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = visible.length > 1 ? `${line}L${x(visible[visible.length - 1].t).toFixed(1)},${PAD_TOP + HEIGHT}L${x(visible[0].t).toFixed(1)},${PAD_TOP + HEIGHT}Z` : "";
  const last = visible[visible.length - 1];
  const other = compare?.points.filter((p) => p.t >= start) ?? [];
  const otherLine = other.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");

  const nearest = (t: number) =>
    visible.reduce<Point | undefined>((best, p) => (!best || Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best), undefined);
  const active = hover === undefined ? undefined : nearest(hover);

  const move = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const t = start + ((e.clientX - box.left - PAD_LEFT) / plotW) * windowMs;
    onHover(nearest(t)?.t);
  };
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const index = active ? visible.indexOf(active) : visible.length;
    const next = visible[Math.min(visible.length - 1, Math.max(0, index + (e.key === "ArrowLeft" ? -1 : 1)))];
    onHover(next?.t);
  };

  const values = visible.map((p) => p.v);
  const summary = visible.length
    ? `${label}，最近 ${Math.round(windowMs / 60000)} 分钟：当前 ${format(last.v)}，最低 ${format(Math.min(...values))}，最高 ${format(Math.max(...values))}`
    : `${label}：正在采样`;

  const minutes = Math.round(windowMs / 60000);
  const xTicks = [minutes, (minutes * 2) / 3, minutes / 3, 0];

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg
          width={width}
          height={PAD_TOP + HEIGHT + AXIS}
          role="img"
          aria-label={summary}
          tabIndex={0}
          onPointerMove={move}
          onPointerLeave={() => onHover(undefined)}
          onBlur={() => onHover(undefined)}
          onKeyDown={key}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line className="chart-grid" x1={PAD_LEFT} x2={PAD_LEFT + plotW} y1={y(v)} y2={y(v)} />
              <text className="chart-tick" x={PAD_LEFT - 6} y={y(v)} textAnchor="end" dominantBaseline="middle">
                {tickFormat ? tickFormat(v) : v}
              </text>
            </g>
          ))}
          {xTicks.map((m) => (
            <text
              key={m}
              className="chart-tick"
              x={x(end - m * 60000)}
              y={PAD_TOP + HEIGHT + 14}
              textAnchor={m === 0 ? "end" : m === minutes ? "start" : "middle"}
            >
              {m === 0 ? "现在" : `${Math.round(m)} 分钟前`}
            </text>
          ))}
          <path className="chart-area" d={area} />
          {otherLine && <path className="chart-line chart-line-muted chart-line-thin" d={otherLine} />}
          <path className="chart-line" d={line} />
          {active && (
            <>
              <line className="chart-crosshair" x1={x(active.t)} x2={x(active.t)} y1={PAD_TOP} y2={PAD_TOP + HEIGHT} />
              <circle className="chart-dot" cx={x(active.t)} cy={y(active.v)} r={4} />
            </>
          )}
          {!active && last && <circle className="chart-dot" cx={x(last.t)} cy={y(last.v)} r={4} />}
        </svg>
      )}
      {active && width > 0 && (
        <div
          className="chart-tooltip"
          // Beside the crosshair, flipping left in the right half so it stays inside the plot.
          style={{
            left: x(active.t),
            top: PAD_TOP,
            transform: x(active.t) > PAD_LEFT + plotW / 2 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
          }}
        >
          <strong>{format(active.v)}</strong>
          {compare && (
            <span>
              {compare.label} {format(other.find((p) => p.t === active.t)?.v ?? 0)}
            </span>
          )}
          <span>{clock(active.t)}</span>
        </div>
      )}
      {!visible.length && <div className="chart-empty">正在采样…</div>}
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

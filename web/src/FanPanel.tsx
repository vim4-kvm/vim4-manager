import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useWidth } from "./components/TrendChart";
import type { FanTriggers } from "./api";

// Mirrors kvim4/kvim4n device tree thresholds.
export const DEFAULT_FAN: FanTriggers = { low: 60, mid: 80, high: 100 };

const PRESETS: { name: string; detail: string; triggers: FanTriggers }[] = [
  { name: "安静", detail: "50 °C 前停转", triggers: { low: 65, mid: 85, high: 100 } },
  { name: "均衡", detail: "出厂阈值", triggers: DEFAULT_FAN },
  { name: "凉爽", detail: "更早提速", triggers: { low: 50, mid: 70, high: 90 } },
];

// Limits match internal/board/fan.go and vim4-manager-helper.
const LIMITS = {
  low: (t: FanTriggers) => [35, Math.min(80, t.mid - 5)],
  mid: (t: FanTriggers) => [t.low + 5, Math.min(95, t.high - 5)],
  high: (t: FanTriggers) => [t.mid + 5, 100],
} satisfies Record<keyof FanTriggers, (t: FanTriggers) => number[]>;

const HANDLES: { key: keyof FanTriggers; label: string; duty: number }[] = [
  { key: "low", label: "起转温度", duty: 35 },
  { key: "mid", label: "中速温度", duty: 70 },
  { key: "high", label: "全速温度", duty: 100 },
];

// The SoC thermal zone's first passive trip point, where CPU throttling begins.
const THROTTLE_C = 95;

const T_MIN = 20;
const T_MAX = 105;
const HEIGHT = 168;
const PAD_LEFT = 34;
const PAD_RIGHT = 14;
const PAD_TOP = 22;
const AXIS = 22;

const same = (a: FanTriggers, b: FanTriggers) => a.low === b.low && a.mid === b.mid && a.high === b.high;

function problem(t: FanTriggers): string | undefined {
  for (const { key, label } of HANDLES) {
    const [lo, hi] = LIMITS[key](t);
    if (!Number.isInteger(t[key]) || t[key] < lo || t[key] > hi) return `${label}需在 ${lo}–${hi} °C 之间`;
  }
  return undefined;
}

/** Vertices of mcu_fan_auto_speed_percent in drivers/misc/khadas-mcu.c. */
function vertices(t: FanTriggers): [number, number][] {
  const start = Math.max(t.low - 15, 0);
  const daily = Math.max(t.low - 5, start + 1);
  return [
    [start, 5],
    [daily, 25],
    [t.low, 35],
    [t.mid, 70],
    [t.high, 100],
  ];
}

export function fanDuty(t: FanTriggers, temp: number): number {
  const points = vertices(t);
  if (temp < points[0][0]) return 0;
  for (let i = 1; i < points.length; i++) {
    const [t0, d0] = points[i - 1];
    const [t1, d1] = points[i];
    if (temp < t1) return Math.round(d0 + ((temp - t0) * (d1 - d0)) / (t1 - t0));
  }
  return 100;
}

function CurveEditor({
  draft,
  saved,
  tempC,
  percent,
  disabled,
  onChange,
}: {
  draft: FanTriggers;
  saved: FanTriggers;
  tempC: number;
  percent: number;
  disabled: boolean;
  onChange: (next: FanTriggers) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const gradientId = useId();
  const [hover, setHover] = useState<number>();
  const dragging = useRef<keyof FanTriggers>(undefined);
  const plotW = Math.max(0, width - PAD_LEFT - PAD_RIGHT);
  const x = (t: number) => PAD_LEFT + ((Math.min(T_MAX, Math.max(T_MIN, t)) - T_MIN) / (T_MAX - T_MIN)) * plotW;
  const y = (p: number) => PAD_TOP + (1 - p / 100) * HEIGHT;
  const tempAt = (clientX: number, box: DOMRect) => T_MIN + ((clientX - box.left - PAD_LEFT) / plotW) * (T_MAX - T_MIN);

  const path = (t: FanTriggers) => {
    const points = vertices(t);
    return [
      `M${x(T_MIN)},${y(0)}`,
      `L${x(points[0][0])},${y(0)}`,
      ...points.map(([tc, d]) => `L${x(tc)},${y(d)}`),
      `L${x(T_MAX)},${y(100)}`,
    ].join("");
  };

  const set = (key: keyof FanTriggers, value: number) => {
    const [lo, hi] = LIMITS[key](draft);
    const next = Math.min(hi, Math.max(lo, Math.round(value)));
    if (next !== draft[key]) onChange({ ...draft, [key]: next });
  };

  const move = (e: PointerEvent<SVGSVGElement>) => {
    const temp = tempAt(e.clientX, e.currentTarget.getBoundingClientRect());
    if (dragging.current) set(dragging.current, temp);
    else setHover(temp >= T_MIN && temp <= T_MAX ? Math.round(temp) : undefined);
  };

  const key = (handle: keyof FanTriggers) => (e: KeyboardEvent<SVGGElement>) => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -5, PageUp: 5 }[e.key];
    if (step === undefined || disabled) return;
    e.preventDefault();
    set(handle, draft[handle] + step);
  };

  const dirty = !same(draft, saved);
  const hoverDuty = hover === undefined ? undefined : fanDuty(draft, hover);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground" aria-hidden={!dirty}>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3.5 rounded-sm bg-primary" />
          {dirty ? "调整后" : "当前曲线"}
        </span>
        {dirty && (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-3.5 rounded-sm bg-idle border-t border-dashed border-idle" />
            正在生效
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-primary" />
          当前 {tempC.toFixed(1)} °C · {percent}%
        </span>
      </div>
      <div className="relative min-w-0 [&_svg]:block [&_svg]:overflow-visible" ref={ref}>
        {width > 0 && (
          <svg
            width={width}
            height={PAD_TOP + HEIGHT + AXIS}
            role="group"
            aria-label="风扇曲线：拖动或用方向键调整三个温度点"
            onPointerMove={move}
            onPointerUp={() => (dragging.current = undefined)}
            onPointerCancel={() => (dragging.current = undefined)}
            onPointerLeave={() => setHover(undefined)}
            className={disabled ? "pointer-events-none opacity-50" : undefined}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--primary)" stopOpacity=".18" />
                <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path fill={`url(#${gradientId})`} d={`${path(draft)}L${x(T_MAX)},${y(0)}Z`} />
            {[0, 50, 100].map((v) => (
              <g key={v}>
                <line className="stroke-border stroke-1 [shape-rendering:crispEdges]" x1={PAD_LEFT} x2={PAD_LEFT + plotW} y1={y(v)} y2={y(v)} />
                <text className="fill-muted-foreground text-[11px] tabular-nums" x={PAD_LEFT - 8} y={y(v)} textAnchor="end" dominantBaseline="middle">
                  {v}%
                </text>
              </g>
            ))}
            {[20, 40, 60, 80, 100].map((t) => (
              <text key={t} className="fill-muted-foreground text-[11px] tabular-nums" x={x(t)} y={PAD_TOP + HEIGHT + 16} textAnchor="middle">
                {t}°
              </text>
            ))}
            <rect className="fill-destructive/10" x={x(THROTTLE_C)} y={PAD_TOP} width={x(T_MAX) - x(THROTTLE_C)} height={HEIGHT} />
            <text className="fill-muted-foreground text-[11px] tabular-nums" x={x(THROTTLE_C) - 6} y={PAD_TOP + HEIGHT - 8} textAnchor="end">
              {THROTTLE_C}° 起 CPU 降频
            </text>
            {dirty && <path className="fill-none [stroke-linecap:round] [stroke-linejoin:round] stroke-muted-foreground [stroke-dasharray:4_4] [stroke-width:1.25]" d={path(saved)} />}
            <path className="fill-none stroke-primary [stroke-width:1.75] [stroke-linecap:round] [stroke-linejoin:round]" d={path(draft)} />
            {vertices(draft)
              .slice(0, 2)
              .map(([tc, d]) => (
                <circle key={tc} className="fill-card stroke-primary stroke-2" cx={x(tc)} cy={y(d)} r={3} />
              ))}
            {hover !== undefined && hoverDuty !== undefined && !dragging.current && (
              <line className="stroke-muted-foreground stroke-1 [stroke-dasharray:2_3]" x1={x(hover)} x2={x(hover)} y1={PAD_TOP} y2={PAD_TOP + HEIGHT} />
            )}
            <circle className="pointer-events-none fill-primary stroke-card stroke-3" cx={x(tempC)} cy={y(percent)} r={5} />
            {HANDLES.map(({ key: k, label, duty }) => {
              const [lo, hi] = LIMITS[k](draft);
              return (
                <g
                  key={k}
                  className="group/handle cursor-ew-resize outline-none"
                  role="slider"
                  tabIndex={disabled ? -1 : 0}
                  aria-label={label}
                  aria-valuemin={lo}
                  aria-valuemax={hi}
                  aria-valuenow={draft[k]}
                  aria-valuetext={`${draft[k]} °C，占空比 ${duty}%`}
                  aria-disabled={disabled}
                  onKeyDown={key(k)}
                  onPointerDown={(e) => {
                    if (disabled) return;
                    e.preventDefault();
                    (e.currentTarget.ownerSVGElement ?? e.currentTarget).setPointerCapture?.(e.pointerId);
                    (e.currentTarget as SVGGElement).focus();
                    dragging.current = k;
                    setHover(undefined);
                  }}
                >
                  <circle className="fill-transparent group-hover/handle:fill-primary/10 group-focus-visible/handle:fill-primary/10" cx={x(draft[k])} cy={y(duty)} r={18} />
                  <circle className="fill-card stroke-primary stroke-2 group-hover/handle:[r:8] group-focus-visible/handle:[r:8]" cx={x(draft[k])} cy={y(duty)} r={7} />
                  <text className="pointer-events-none fill-foreground stroke-card stroke-4 text-[11.5px] font-semibold tabular-nums [paint-order:stroke] [stroke-linejoin:round]" x={x(draft[k])} y={y(duty) - 14} textAnchor="middle">
                    {draft[k]}°
                  </text>
                </g>
              );
            })}
          </svg>
        )}
        {hover !== undefined && hoverDuty !== undefined && width > 0 && (
          <div
            className="pointer-events-none absolute top-0 z-10 flex items-baseline gap-2 rounded-md border bg-popover px-2 py-1 text-xs tabular-nums shadow-md"
            style={{
              left: x(hover),
              top: PAD_TOP + HEIGHT - 34,
              transform: x(hover) > PAD_LEFT + plotW / 2 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
            }}
          >
            <strong>{hoverDuty > 0 ? `${hoverDuty}%` : "停转"}</strong>
            <span>{hover} °C</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function FanPanel({
  saved,
  auto,
  tempC,
  percent,
  busy,
  onApply,
}: {
  saved: FanTriggers;
  auto: boolean;
  tempC: number;
  percent: number;
  busy: boolean;
  onApply: (triggers: FanTriggers) => Promise<void>;
}) {
  const [draft, setDraft] = useState<FanTriggers>();
  const shown = draft ?? saved;
  const dirty = !same(shown, saved);
  const invalid = problem(shown);
  const preset = PRESETS.find((p) => same(p.triggers, shown));
  const start = vertices(shown)[0][0];

  const apply = async () => {
    await onApply(shown);
    setDraft(undefined);
  };

  return (
    <div className="grid min-w-0 gap-6 @2xl:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-5 [&>.flex>button]:h-auto [&>.flex>button]:min-w-0 [&>.flex>button]:flex-1 [&>.flex>button]:flex-col [&>.flex>button]:items-start [&>.flex>button]:whitespace-normal">
        <div className="flex flex-wrap gap-1 rounded-md border bg-muted p-1 [&_button[aria-pressed=true]]:bg-card [&_button[aria-pressed=true]]:text-foreground" role="group" aria-label="预设曲线">
          {PRESETS.map((p) => (
            <Button variant="outline"
              key={p.name}
              type="button"
              aria-pressed={preset === p}
              disabled={busy}
              onClick={() => setDraft(p.triggers)}
            >
              <strong>{p.name}</strong>
              <span>{p.detail}</span>
            </Button>
          ))}
          <span className={`flex min-w-0 flex-col px-3 py-2 text-sm text-muted-foreground [&[aria-hidden=true]]:hidden${preset ? "" : " rounded-md bg-card text-foreground"}`} aria-hidden={!!preset}>
            <strong>自定义</strong>
            <span>拖动曲线</span>
          </span>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {HANDLES.map(({ key, label, duty }) => (
            <label key={key} className="flex min-w-0 flex-col gap-2 text-xs">
              <span className="text-xs font-medium">{label}</span>
              <span className="flex items-center gap-1 rounded-md [&_input]:px-2">
                <Input
                  type="number"
                  inputMode="numeric"
                  value={Number.isNaN(shown[key]) ? "" : shown[key]}
                  disabled={busy}
                  onChange={(e) => setDraft({ ...shown, [key]: e.target.valueAsNumber })}
                />
                <span>°C</span>
              </span>
              <span className="text-xs text-muted-foreground">占空比 {duty}%</span>
            </label>
          ))}
        </div>

        <p className="text-sm text-muted-foreground">
          {invalid ? (
            <span className="text-destructive" role="alert">
              {invalid}
            </span>
          ) : (
            <>
              低于 {start} °C 停转，{start} °C 起以 5% 起转；到 {shown.high} °C 全速。驱动每 30 秒调整一次，每次最多变化 5%。
            </>
          )}
        </p>

        <div className="mt-auto flex flex-wrap items-center justify-end gap-2">
          {!auto && <span className="text-muted-foreground">当前为手动模式，应用后改为自动调速。</span>}
          <Button size="sm" variant="outline"
            type="button"

            disabled={busy || same(shown, DEFAULT_FAN)}
            onClick={() => setDraft(DEFAULT_FAN)}
          >
            恢复出厂
          </Button>
          {dirty && (
            <Button size="sm" variant="outline" type="button" disabled={busy} onClick={() => setDraft(undefined)}>
              撤销
            </Button>
          )}
          <Button size="sm" variant="default"
            type="button"

            disabled={busy || !!invalid || (!dirty && auto)}
            onClick={() => void apply()}
          >
            {auto ? "应用曲线" : "应用并启用自动"}
          </Button>
        </div>
      </div>
      <CurveEditor
        draft={invalid ? saved : shown}
        saved={saved}
        tempC={tempC}
        percent={percent}
        disabled={busy}
        onChange={setDraft}
      />
    </div>
  );
}

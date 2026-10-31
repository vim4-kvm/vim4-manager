import { Segmented, SegmentedOption, SegmentedStatic } from "@/components/Segmented";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useWidth } from "./components/TrendChart";
import type { FanTriggers } from "./api";
import { t, useT } from "./i18n";
import { number } from "./i18n/format";

// Mirrors kvim4/kvim4n device tree thresholds.
export const DEFAULT_FAN: FanTriggers = { low: 60, mid: 80, high: 100 };

const PRESETS: { name: string; detail: string; triggers: FanTriggers }[] = [
  { get name() { return t("cooling.quiet"); }, get detail() { return t("cooling.quietHelp"); }, triggers: { low: 65, mid: 85, high: 100 } },
  { get name() { return t("cooling.balanced"); }, get detail() { return t("cooling.balancedHelp"); }, triggers: DEFAULT_FAN },
  { get name() { return t("cooling.cool"); }, get detail() { return t("cooling.coolHelp"); }, triggers: { low: 50, mid: 70, high: 90 } },
];

// Limits match internal/board/fan.go and vim4-manager-helper.
const LIMITS = {
  low: (t: FanTriggers) => [35, Math.min(80, t.mid - 5)],
  mid: (t: FanTriggers) => [t.low + 5, Math.min(95, t.high - 5)],
  high: (t: FanTriggers) => [t.mid + 5, 100],
} satisfies Record<keyof FanTriggers, (t: FanTriggers) => number[]>;

const HANDLES: { key: keyof FanTriggers; label: string; duty: number }[] = [
  { key: "low", get label() { return t("cooling.start"); }, duty: 35 },
  { key: "mid", get label() { return t("cooling.mid"); }, duty: 70 },
  { key: "high", get label() { return t("cooling.high"); }, duty: 100 },
];

// The SoC thermal zone's first passive trip point, where CPU throttling begins.
const THROTTLE_C = 95;

const T_MIN = 20;
const T_MAX = 105;
const HEIGHT = 240;
const PAD_LEFT = 34;
const PAD_RIGHT = 14;
const PAD_TOP = 22;
const AXIS = 22;

const same = (a: FanTriggers, b: FanTriggers) => a.low === b.low && a.mid === b.mid && a.high === b.high;

function problem(t: FanTriggers): string | undefined {
  for (const { key, label } of HANDLES) {
    const [lo, hi] = LIMITS[key](t);
    if (!Number.isInteger(t[key]) || t[key] < lo || t[key] > hi) return invalidTemperature(label, lo, hi);
  }
  return undefined;
}

function invalidTemperature(label: string, min: number, max: number) {
  return t("cooling.invalid", { label, min: number(min), max: number(max) });
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
  const t = useT();
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
          {dirty ? t("cooling.adjusted") : t("cooling.currentCurve")}
        </span>
        {dirty && (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-3.5 rounded-sm bg-idle border-t border-dashed border-idle" />
            {t("cooling.active")}
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-primary" />
          {t("cooling.current", { temperature: number(tempC, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), percent: number(percent) })}
        </span>
      </div>
      <div className="relative min-w-0 [&_svg]:block [&_svg]:overflow-visible" ref={ref}>
        {width > 0 && (
          <svg
            width={width}
            height={PAD_TOP + HEIGHT + AXIS}
            role="group"
            aria-label={t("cooling.editor")}
            onPointerMove={move}
            onPointerUp={() => (dragging.current = undefined)}
            onPointerCancel={() => (dragging.current = undefined)}
            onPointerLeave={() => setHover(undefined)}
            className={disabled ? "pointer-events-none opacity-50" : undefined}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-1)" stopOpacity=".18" />
                <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path fill={`url(#${gradientId})`} d={`${path(draft)}L${x(T_MAX)},${y(0)}Z`} />
            {[0, 50, 100].map((v) => (
              <g key={v}>
                <line className="stroke-border stroke-1 [shape-rendering:crispEdges]" x1={PAD_LEFT} x2={PAD_LEFT + plotW} y1={y(v)} y2={y(v)} />
                <text className="fill-muted-foreground text-xs tabular-nums" x={PAD_LEFT - 8} y={y(v)} textAnchor="end" dominantBaseline="middle">
                  {v}%
                </text>
              </g>
            ))}
            {[20, 40, 60, 80, 100].map((t) => (
              <text key={t} className="fill-muted-foreground text-xs tabular-nums" x={x(t)} y={PAD_TOP + HEIGHT + 16} textAnchor="middle">
                {t}°
              </text>
            ))}
            <rect className="fill-destructive-fill/10" x={x(THROTTLE_C)} y={PAD_TOP} width={x(T_MAX) - x(THROTTLE_C)} height={HEIGHT} />
            <text className="fill-muted-foreground text-xs tabular-nums" x={x(THROTTLE_C) - 6} y={PAD_TOP + HEIGHT - 8} textAnchor="end">
              {t("cooling.throttle", { temperature: number(THROTTLE_C) })}
            </text>
            {dirty && <path className="fill-none [stroke-linecap:round] [stroke-linejoin:round] stroke-muted-foreground [stroke-dasharray:4_4] [stroke-width:1.25]" d={path(saved)} />}
            <path className="fill-none stroke-chart-1 [stroke-width:2] [stroke-linecap:round] [stroke-linejoin:round]" d={path(draft)} />
            {vertices(draft)
              .slice(0, 2)
              .map(([tc, d]) => (
                <circle key={tc} className="fill-card stroke-chart-1 stroke-2" cx={x(tc)} cy={y(d)} r={3} />
              ))}
            {hover !== undefined && hoverDuty !== undefined && !dragging.current && (
              <line className="stroke-muted-foreground stroke-1 [stroke-dasharray:2_3]" x1={x(hover)} x2={x(hover)} y1={PAD_TOP} y2={PAD_TOP + HEIGHT} />
            )}
            <line className="stroke-chart-1/60 stroke-1 [stroke-dasharray:4_4]" x1={x(tempC)} x2={x(tempC)} y1={PAD_TOP} y2={PAD_TOP + HEIGHT} />
            <circle className="pointer-events-none fill-chart-1 stroke-card stroke-3" cx={x(tempC)} cy={y(percent)} r={5} />
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
                  aria-valuetext={t("cooling.slider", { temperature: number(draft[k]), duty: number(duty) })}
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
                  <circle className="fill-card stroke-chart-1 stroke-2 group-hover/handle:[r:8] group-focus-visible/handle:[r:8]" cx={x(draft[k])} cy={y(duty)} r={7} />
                  <text className="pointer-events-none fill-foreground stroke-card stroke-4 text-xs font-medium tabular-nums [paint-order:stroke] [stroke-linejoin:round]" x={x(draft[k])} y={y(duty) - 14} textAnchor="middle">
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
            <strong>{hoverDuty > 0 ? `${number(hoverDuty)}%` : t("cooling.stopped")}</strong>
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
  const t = useT();
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
    <div className="min-w-0">
      <div className="flex min-w-0 flex-col gap-5">
        <Segmented label={t("cooling.presets")}>
          {PRESETS.map((p) => (
            <SegmentedOption key={p.name} title={p.name} detail={p.detail} pressed={preset === p} disabled={busy} onClick={() => setDraft(p.triggers)} />
          ))}
          {!preset && <SegmentedStatic title={t("cooling.custom")} detail={t("cooling.drag")} />}
        </Segmented>

        <CurveEditor
          draft={invalid ? saved : shown}
          saved={saved}
          tempC={tempC}
          percent={percent}
          disabled={busy}
          onChange={setDraft}
        />

        <div className="grid grid-cols-3 gap-3">
          {HANDLES.map(({ key, label, duty }) => (
            <label key={key} className="flex min-w-0 flex-col gap-2 text-xs">
              <span className="text-xs font-medium">{label}</span>
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground [&_input]:px-2 [&_input]:tabular-nums [&_input]:text-foreground">
                <Input
                  type="number"
                  inputMode="numeric"
                  value={Number.isNaN(shown[key]) ? "" : shown[key]}
                  disabled={busy}
                  onChange={(e) => setDraft({ ...shown, [key]: e.target.valueAsNumber })}
                />
                <span>°C</span>
              </span>
              <span className="text-xs text-muted-foreground">{t("cooling.duty", { duty: number(duty) })}</span>
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
              {t("cooling.explanation", { start: number(start), high: number(shown.high) })}
            </>
          )}
        </p>

        <div className="mt-auto flex flex-wrap items-center justify-end gap-2">
          {!auto && <span className="mr-auto text-sm text-muted-foreground">{t("cooling.manualHelp")}</span>}
          <Button variant="outline"
            type="button"
            disabled={busy || same(shown, DEFAULT_FAN)}
            onClick={() => setDraft(DEFAULT_FAN)}
          >
            {t("cooling.restore")}
          </Button>
          {dirty && (
            <Button variant="outline" type="button" disabled={busy} onClick={() => setDraft(undefined)}>
              {t("cooling.undo")}
            </Button>
          )}
          <Button variant="default"
            type="button"
            disabled={busy || !!invalid || (!dirty && auto)}
            onClick={() => void apply()}
          >
            {auto ? t("cooling.apply") : t("cooling.applyAuto")}
          </Button>
        </div>
      </div>
    </div>
  );
}

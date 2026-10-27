import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { DEFAULT_HDR_CURVE, type HDRCurve } from "./api";

// Slider ranges. SDR white runs high to low so that "right" means brighter.
// The 12-bit HDR gain register limits SDR white to 157 nits and up.
const WHITE_MIN = 160;
const WHITE_MAX = 400;
const PEAK_MAX = 10000;
// The curve chart spans 0.1 to 10000 nits on a log axis.
const NITS_MIN = 0.1;
const NITS_MAX = 10000;
const PREVIEW_MS = 120;

const HEIGHT = 200;
const PAD_LEFT = 30;
const PAD_RIGHT = 8;
const PAD_TOP = 8;
const AXIS = 20;

// Mirrors tools/hdr-curve.sh: linear to 95% of white, extended Reinhard
// shoulder to the peak. Returns SDR output relative to SDR white (0..1).
function mapNits(nits: number, curve: HDRCurve): number {
  const knee = 0.95;
  const r = nits / curve.white;
  if (r <= knee) return r;
  const top = (curve.peak / curve.white - knee) / (1 - knee);
  const t = Math.min((r - knee) / (1 - knee), top);
  return knee + (1 - knee) * ((t * (1 + t / (top * top))) / (1 + t));
}

// The vendor table this replaces maps 400 nits to SDR white and compresses
// from about 300 nits on; approximated here as the same shoulder.
const VENDOR: HDRCurve = { white: 400, peak: 10000 };

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function srgb(linear: number): number {
  const l = Math.min(1, Math.max(0, linear));
  return l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055;
}

const logPos = (v: number, min: number, max: number) => Math.log(v / min) / Math.log(max / min);
const fromLog = (p: number, min: number, max: number) => min * (max / min) ** p;

function nitsLabel(n: number): string {
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}K`;
  return n >= 10 ? `${Math.round(n)}` : `${+n.toFixed(1)}`;
}

function useWidth<T extends HTMLElement>() {
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

/** Output level (SDR code value, 0..100%) against HDR input nits. */
function CurveChart({ curve }: { curve: HDRCurve }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const gradientId = useId();
  const [hover, setHover] = useState<number>();
  const plotW = Math.max(0, width - PAD_LEFT - PAD_RIGHT);
  const x = (n: number) => PAD_LEFT + logPos(n, NITS_MIN, NITS_MAX) * plotW;
  const y = (v: number) => PAD_TOP + (1 - v) * HEIGHT;
  const samples = Array.from({ length: 121 }, (_, i) => fromLog(i / 120, NITS_MIN, NITS_MAX));
  const path = (c: HDRCurve) =>
    samples.map((n, i) => `${i ? "L" : "M"}${x(n).toFixed(1)},${y(srgb(mapNits(n, c))).toFixed(1)}`).join("");
  const xTicks = [0.1, 1, 10, 100, 1000, 10000];
  const yTicks = [0, 0.5, 1];
  const active = hover;

  const move = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const p = (e.clientX - box.left - PAD_LEFT) / plotW;
    setHover(p < 0 || p > 1 ? undefined : fromLog(p, NITS_MIN, NITS_MAX));
  };
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const p = hover === undefined ? logPos(curve.white, NITS_MIN, NITS_MAX) : logPos(hover, NITS_MIN, NITS_MAX);
    setHover(fromLog(Math.min(1, Math.max(0, p + (e.key === "ArrowLeft" ? -0.02 : 0.02))), NITS_MIN, NITS_MAX));
  };
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const summary = `映射曲线：${curve.white} 尼特映射为 SDR 白的 ${pct(srgb(mapNits(curve.white, curve)))}，${curve.peak} 尼特以上为满白`;

  return (
    <figure className="flex min-w-0 flex-col gap-3 [&_figcaption]:flex [&_figcaption]:flex-wrap [&_figcaption]:gap-4">
      <figcaption>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-0.5 w-3.5 rounded-sm bg-chart-1" aria-hidden="true" />
          当前曲线
        </span>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-0.5 w-3.5 rounded-sm bg-idle" aria-hidden="true" />
          厂商默认
        </span>
      </figcaption>
      <div className="relative min-w-0 [&_svg]:block [&_svg]:overflow-visible [&_svg]:touch-pan-y [&_svg]:outline-none [&_svg:focus-visible]:ring-3 [&_svg:focus-visible]:ring-ring/50" ref={ref}>
        {width > 0 && (
          <svg
            width={width}
            height={PAD_TOP + HEIGHT + AXIS}
            role="img"
            aria-label={summary}
            tabIndex={0}
            onPointerMove={move}
            onPointerLeave={() => setHover(undefined)}
            onKeyDown={key}
            onBlur={() => setHover(undefined)}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-1)" stopOpacity=".18" />
                <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path fill={`url(#${gradientId})`} d={`${path(curve)}L${x(NITS_MAX)},${y(0)}L${x(NITS_MIN)},${y(0)}Z`} />
            {yTicks.map((v) => (
              <g key={v}>
                <line className="stroke-border stroke-1 [shape-rendering:crispEdges]" x1={PAD_LEFT} x2={PAD_LEFT + plotW} y1={y(v)} y2={y(v)} />
                <text className="fill-muted-foreground text-[11px] tabular-nums" x={PAD_LEFT - 6} y={y(v) + 4} textAnchor="end">
                  {pct(v)}
                </text>
              </g>
            ))}
            {xTicks.map((n) => (
              <text key={n} className="fill-muted-foreground text-[11px] tabular-nums" x={x(n)} y={PAD_TOP + HEIGHT + 15} textAnchor="middle">
                {nitsLabel(n)}
              </text>
            ))}
            <line className="stroke-input stroke-1 [stroke-dasharray:2_3]" x1={x(curve.white)} x2={x(curve.white)} y1={PAD_TOP} y2={PAD_TOP + HEIGHT} />
            <line className="stroke-input stroke-1 [stroke-dasharray:2_3]" x1={x(curve.peak)} x2={x(curve.peak)} y1={PAD_TOP} y2={PAD_TOP + HEIGHT} />
            <text className="fill-muted-foreground text-[11px] tabular-nums" x={x(curve.white) - 6} y={PAD_TOP + HEIGHT - 6} textAnchor="end">
              桌面白
            </text>
            <text className="fill-muted-foreground text-[11px] tabular-nums" x={x(curve.peak) + 6} y={PAD_TOP + HEIGHT - 6}>
              高光上限
            </text>
            <path className="fill-none [stroke-width:1.75] [stroke-linecap:round] [stroke-linejoin:round] stroke-muted-foreground" d={path(VENDOR)} />
            <path className="fill-none stroke-chart-1 [stroke-width:2] [stroke-linecap:round] [stroke-linejoin:round]" d={path(curve)} />
            <circle className="fill-chart-1 stroke-card stroke-3" cx={x(curve.white)} cy={y(srgb(mapNits(curve.white, curve)))} r={4} />
            {active !== undefined && (
              <>
                <line className="stroke-muted-foreground stroke-1 [stroke-dasharray:2_3]" x1={x(active)} x2={x(active)} y1={PAD_TOP} y2={PAD_TOP + HEIGHT} />
                <circle className="fill-chart-1 stroke-card stroke-3" cx={x(active)} cy={y(srgb(mapNits(active, curve)))} r={4} />
              </>
            )}
          </svg>
        )}
        {active !== undefined && width > 0 && (
          <div
            className="pointer-events-none absolute z-10 flex items-baseline gap-2 rounded-md border bg-popover px-2 py-1 text-xs tabular-nums shadow-md"
            style={{ left: Math.min(Math.max(x(active) - 70, 0), width - 160), top: 0 }}
          >
            <strong>{pct(srgb(mapNits(active, curve)))}</strong>
            <span>
              {nitsLabel(active)} 尼特 · 厂商 {pct(srgb(mapNits(active, VENDOR)))}
            </span>
          </div>
        )}
      </div>
      <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span>输入亮度（尼特，对数刻度）</span>
        <span>
          桌面白 {curve.white} · 高光上限 {nitsLabel(curve.peak)}
        </span>
      </div>
    </figure>
  );
}

/**
 * The mapped gray ramp: 0 to desktop white in even sRGB steps, then the
 * highlight range from white to the peak, which shares the top 5%.
 */
function Ramp({ curve }: { curve: HDRCurve }) {
  const cell = (n: number) => {
    const v = Math.round(srgb(mapNits(n, curve)) * 255);
    return { n, color: `rgb(${v},${v},${v})` };
  };
  const body = Array.from({ length: 16 }, (_, i) => cell(curve.white * srgbToLinear(i / 15)));
  const highlights = Array.from({ length: 4 }, (_, i) => cell(fromLog((i + 1) / 4, curve.white, curve.peak)));
  const strip = (cells: { n: number; color: string }[]) =>
    cells.map((c, i) => <span key={i} style={{ background: c.color }} title={`${nitsLabel(c.n)} 尼特`} />);
  return (
    <div className="grid grid-cols-[4fr_1fr] gap-x-0.5 gap-y-1.5 text-xs [&>span:nth-of-type(1)]:col-start-1 [&>span:nth-of-type(1)]:row-start-2 [&>span:nth-of-type(2)]:col-start-1 [&>span:nth-of-type(2)]:row-start-2 [&>span:nth-of-type(2)]:justify-self-end [&>span:nth-of-type(3)]:col-start-2 [&>span:nth-of-type(3)]:row-start-2 [&>span:nth-of-type(3)]:justify-self-end" role="img" aria-label={`映射后的灰阶：黑到桌面白 ${curve.white} 尼特，再到高光上限 ${curve.peak} 尼特`}>
      <div className="grid h-6 auto-cols-fr grid-flow-col overflow-hidden rounded-l-md border border-input">{strip(body)}</div>
      <div className="grid h-6 auto-cols-fr grid-flow-col overflow-hidden rounded-r-md border border-input">{strip(highlights)}</div>
      <span className="text-muted-foreground">黑</span>
      <span className="text-muted-foreground">桌面白 {curve.white}</span>
      <span className="text-muted-foreground">高光 {nitsLabel(curve.peak)}</span>
    </div>
  );
}

/** A 0..1000 range input; the caller maps positions to nits. */
function Slider({
  label,
  value,
  detail,
  position,
  ends,
  disabled,
  onInput,
  onCommit,
}: {
  label: string;
  value: string;
  detail: string;
  position: number;
  ends: [string, string];
  disabled: boolean;
  onInput: (position: number) => void;
  onCommit: () => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="flex flex-wrap justify-between gap-3 [&_strong]:font-medium [&_strong]:tabular-nums">
        <span>{label}</span>
        <strong>{value}</strong>
      </span>
      <input
        type="range"
        className="my-2 h-2 w-full cursor-pointer accent-chart-1 focus-visible:outline-ring disabled:opacity-50"
        min={0}
        max={1000}
        value={position}
        disabled={disabled}
        aria-valuetext={value}
        onChange={(e) => onInput(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit}
      />
      <span className="flex justify-between text-xs text-muted-foreground" aria-hidden="true">
        <span>{ends[0]}</span>
        <span>{ends[1]}</span>
      </span>
      <small className="text-muted-foreground">{detail}</small>
    </label>
  );
}

export function HDRPanel({
  curve,
  hdr,
  mappingEnabled = true,
  busy,
  onPreview,
  onSave,
}: {
  curve: HDRCurve;
  hdr?: string;
  mappingEnabled?: boolean;
  busy: boolean;
  onPreview: (curve: HDRCurve) => Promise<unknown>;
  onSave: (curve: HDRCurve) => void;
}) {
  const [draft, setDraft] = useState(curve);
  const editing = useRef(false);
  const pending = useRef<HDRCurve>(undefined);
  const inFlight = useRef(false);

  // Follow the saved curve unless the user is mid-drag.
  const saved = `${curve.white}/${curve.peak}`;
  const [shown, setShown] = useState(saved);
  if (shown !== saved && !editing.current) {
    setShown(saved);
    setDraft(curve);
  }

  // Throttled live preview: at most one request in flight, the latest wins.
  const preview = (next: HDRCurve) => {
    pending.current = next;
    if (inFlight.current) return;
    const send = () => {
      const target = pending.current;
      pending.current = undefined;
      if (!target) {
        inFlight.current = false;
        return;
      }
      inFlight.current = true;
      onPreview(target)
        .catch(() => undefined)
        .finally(() => window.setTimeout(send, PREVIEW_MS));
    };
    send();
  };

  const update = (next: HDRCurve) => {
    editing.current = true;
    setDraft(next);
    preview(next);
  };
  const commit = () => {
    if (!editing.current) return;
    editing.current = false;
    if (draft.white !== curve.white || draft.peak !== curve.peak) onSave(draft);
  };

  // Brightness slider position: 0 = dim (400 nits white), 1000 = bright (100).
  const brightPos = Math.round((1 - logPos(draft.white, WHITE_MIN, WHITE_MAX)) * 1000);
  const peakMin = Math.max(draft.white * 1.5, 300);
  const peakPos = Math.round(logPos(draft.peak, peakMin, PEAK_MAX) * 1000);
  const isDefault = curve.white === DEFAULT_HDR_CURVE.white && curve.peak === DEFAULT_HDR_CURVE.peak;
  const live = hdr && hdr !== "SDR";

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-col gap-5">
        <div className="grid gap-5 @md:grid-cols-2">
          <Slider
            label="桌面亮度"
            value={`SDR 白 ${draft.white} 尼特`}
            detail="对齐主机界面白色。macOS 实测约 199，BT.2408 标准 203。"
            position={brightPos}
            ends={["更暗", "更亮"]}
            disabled={busy}
            onInput={(p) => {
              const white = Math.round(fromLog(1 - p / 1000, WHITE_MIN, WHITE_MAX));
              update({ white, peak: Math.max(draft.peak, Math.ceil(white * 1.5)) });
            }}
            onCommit={commit}
          />
          <Slider
            label="高光范围"
            value={`保留到 ${nitsLabel(draft.peak)} 尼特`}
            detail="更高保留更多高光层次，但整体高光更灰。HDR 视频多为 1000 尼特母版。"
            position={peakPos}
            ends={["更通透", "更多细节"]}
            disabled={busy}
            onInput={(p) => update({ white: draft.white, peak: Math.round(fromLog(p / 1000, peakMin, PEAK_MAX)) })}
            onCommit={commit}
          />
        </div>
        <CurveChart curve={draft} />
        <Ramp curve={draft} />
        <div className="mt-auto flex flex-wrap items-center justify-between gap-3">
          <span className="text-muted-foreground">
            {!mappingEnabled ? "转换已关闭；SDR 兼容画面仍使用已保存曲线。" : live ? "拖动时网页画面实时变化，松开后保存。" : hdr === "SDR" ? "当前输入为 SDR，曲线在被控机开启 HDR 后生效。" : "当前无 HDMI 信号。"}
          </span>
          <Button variant="outline" disabled={busy || isDefault} onClick={() => onSave(DEFAULT_HDR_CURVE)}>
            恢复默认
          </Button>
        </div>
      </div>
    </div>
  );
}

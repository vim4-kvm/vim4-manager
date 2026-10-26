import { useEffect, useId, useState, type RefObject } from "react";
import { useReducedMotion } from "motion/react";
import type { Tone } from "./StatusDot";

type Port = "network" | "usb" | "input" | "output";
type Point = { x: number; y: number };
type Route = { id: Port | "internal"; d: string; tone: Tone; bidirectional?: boolean };

/** A single rounded turn, with a horizontal departure and vertical port entry. */
function topEntry(from: Point, to: Point) {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  const radius = Math.min(16, Math.abs(to.y - from.y), Math.abs(to.x - from.x) / 2);
  return `M${from.x} ${from.y} H${to.x - dx * radius} Q${to.x} ${from.y} ${to.x} ${from.y + dy * radius} V${to.y}`;
}

export function ConnectionLines({ mapRef, tones }: {
  mapRef: RefObject<HTMLDivElement | null>; tones: Record<Port, Tone>;
}) {
  const markerId = useId();
  const reducedMotion = useReducedMotion();
  const [layout, setLayout] = useState<{ width: number; height: number; paths: Record<Port | "internal", string> }>();

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const update = () => {
      // On small screens cards are stacked and the diagram has no external wires.
      if (getComputedStyle(map).display === "grid") {
        setLayout(undefined);
        return;
      }
      const bounds = map.getBoundingClientRect();
      const board = map.querySelector<HTMLElement>(".connection-board")!.getBoundingClientRect();
      const point = (selector: string, side?: "left" | "right"): Point => {
        const rect = map.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
        return { x: (side === "left" ? rect.left : side === "right" ? rect.right : rect.left + rect.width / 2) - bounds.left,
          y: rect.top + rect.height / 2 - bounds.top };
      };
      const port = (id: Port) => point(`.connection-port[data-port="${id}"]`);
      const endpoint = (id: Port, side: "left" | "right") => point(`.connection-endpoint-${id}`, side);
      const input = port("input"), output = port("output");
      const source = endpoint("input", "right"), target = endpoint("output", "left");
      const inputBend = (source.x + board.left - bounds.left) / 2;
      const gutter = (board.right - bounds.left + target.x) / 2;
      const radius = 12;
      const outputBend = output.y + board.height * 0.16;
      const soc = { x: board.left - bounds.left + board.width * 0.61, y: board.top - bounds.top + board.height * 0.52 };
      setLayout({ width: bounds.width, height: bounds.height, paths: {
        network: topEntry(endpoint("network", "right"), port("network")),
        usb: topEntry(endpoint("usb", "left"), port("usb")),
        input: `M${source.x} ${source.y} C${inputBend} ${source.y} ${inputBend} ${input.y} ${input.x} ${input.y}`,
        output: `M${output.x} ${output.y} V${outputBend - radius} Q${output.x} ${outputBend} ${output.x + radius} ${outputBend} H${gutter - radius} Q${gutter} ${outputBend} ${gutter} ${outputBend + radius} V${target.y - radius} Q${gutter} ${target.y} ${gutter + radius} ${target.y} H${target.x}`,
        internal: `M${input.x} ${input.y} C${input.x} ${soc.y} ${soc.x} ${soc.y} ${soc.x} ${soc.y} C${output.x} ${soc.y} ${output.x} ${soc.y} ${output.x} ${output.y}`,
      } });
    };
    // Text, sidebar width and zoom change card geometry independently of the photo.
    const observer = new ResizeObserver(update);
    observer.observe(map);
    map.querySelectorAll(".connection-endpoint").forEach((card) => observer.observe(card));
    update();
    return () => observer.disconnect();
  }, [mapRef]);

  if (!layout) return null;
  const routes: Route[] = [
    { id: "network", d: layout.paths.network, tone: tones.network, bidirectional: true },
    { id: "usb", d: layout.paths.usb, tone: tones.usb, bidirectional: true },
    { id: "input", d: layout.paths.input, tone: tones.input },
    { id: "output", d: layout.paths.output, tone: tones.output },
    { id: "internal", d: layout.paths.internal, tone: tones.output },
  ];
  return <svg className="connection-lines" viewBox={`0 0 ${layout.width} ${layout.height}`} fill="none" aria-hidden="true">
    {routes.map((route) => <g key={route.id} className={`connection-route connection-route-${route.id}`} data-tone={route.tone} data-route={route.id}>
      {!route.bidirectional && <defs><marker id={`${markerId}-${route.id}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="m1 1 7 4-7 4" fill="none" stroke="currentColor" strokeWidth="2" /></marker></defs>}
      <path className="connection-line" d={route.d} markerEnd={route.bidirectional ? undefined : `url(#${markerId}-${route.id})`} />
      {route.tone === "good" && reducedMotion === false && [0, 1].map((index) => <circle key={index} className="connection-flow-dot" r={route.id === "internal" ? 2.5 : 3.2}>
        <animateMotion path={route.d} dur={route.bidirectional ? "4s" : "3.4s"} begin={`${-index * 1.7}s`} repeatCount="indefinite"
          keyPoints={route.bidirectional && index === 1 ? "1;0" : "0;1"} keyTimes="0;1" calcMode="linear" />
      </circle>)}
    </g>)}
  </svg>;
}

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Inset group of pressable options (aria-pressed), each with a title and a short detail. */
export function Segmented({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="group" aria-label={label}
      className={cn("grid grid-cols-[repeat(auto-fit,minmax(6rem,1fr))] gap-1 rounded-lg bg-muted p-1", className)}>
      {children}
    </div>
  );
}

const option = "flex min-w-0 flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left";
// Solid in both themes so hover never blends the selected option into the track.
const selected = "bg-chart-1 text-white shadow-xs hover:text-white [&>span]:text-white dark:text-slate-950 dark:hover:text-slate-950 dark:[&>span]:text-slate-950";

export function SegmentedOption({ title, detail, pressed, className, ...props }: {
  title: string;
  detail?: ReactNode;
  pressed: boolean;
} & Omit<React.ComponentProps<"button">, "title">) {
  return (
    <button type="button" aria-pressed={pressed} {...props}
      className={cn(option, "text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50", pressed && selected, className)}>
      <strong className="text-sm font-medium">{title}</strong>
      {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
    </button>
  );
}

/** A non-interactive selected state, e.g. "custom" when no preset matches. */
export function SegmentedStatic({ title, detail }: { title: string; detail?: ReactNode }) {
  return (
    <span className={cn(option, selected)}>
      <span className="text-sm font-medium">{title}</span>
      {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
    </span>
  );
}

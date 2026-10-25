import { cn } from "@/lib/utils";

export type Tone = "good" | "warning" | "critical" | "idle";

const tones: Record<Tone, string> = {
  good: "bg-success",
  warning: "bg-warning",
  critical: "bg-destructive-fill",
  idle: "bg-idle",
};

/** Decorative status lamp; always pair it with visible text. */
export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden="true" data-tone={tone} className={cn("inline-block size-2 shrink-0 rounded-full", tones[tone], className)} />;
}

/** Lamp plus label, for list cells such as services and network links. */
export function StatusLabel({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <StatusDot tone={tone} />
      <span className="min-w-0">{children}</span>
    </span>
  );
}

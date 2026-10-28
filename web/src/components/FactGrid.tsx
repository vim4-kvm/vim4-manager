import { useId, type ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { FadeText } from "@/components/Motion";
import { StatusDot, type Tone } from "@/components/StatusDot";
import { cn } from "@/lib/utils";

const columns = {
  1: "",
  2: "@md:grid-cols-2",
  3: "@md:grid-cols-3",
  4: "@md:grid-cols-2 @4xl:grid-cols-4",
};

/** Read-only facts: one column in narrow cards, otherwise 3 (or 4) columns. */
export function FactGrid({ children, cols = 3, className }: { children: ReactNode; cols?: keyof typeof columns; className?: string }) {
  return <dl className={cn("grid grid-cols-1 gap-x-8 gap-y-4", columns[cols], className)}>{children}</dl>;
}

/**
 * One label/value pair. With `href` the whole tile becomes a link named by
 * its label, value and destination; extra `children` render below.
 */
export function Fact({ label, value, valueKey, detail, tone, href, destination, children, className, card = false, icon: Icon }: {
  label: string;
  value: ReactNode;
  /** Text identity of `value` when it is not a plain string, for the change fade. */
  valueKey?: string;
  detail?: string;
  tone?: Tone;
  href?: string;
  destination?: string;
  children?: ReactNode;
  className?: string;
  card?: boolean;
  icon?: LucideIcon;
}) {
  const id = useId();
  const key = valueKey ?? (typeof value === "string" ? value : "");
  const valueLine = (
    <span className="flex min-w-0 items-center gap-2">
      {tone && <StatusDot tone={tone} />}
      <FadeText id={key} className="min-w-0 [overflow-wrap:anywhere]">{value}</FadeText>
    </span>
  );
  return (
    <div className={cn("group/fact relative flex min-w-0 flex-col gap-0.5", card ? "gap-2 rounded-xl border bg-card p-5 shadow-xs" : href && "-m-2 rounded-md p-2 hover:bg-accent", card && href && "transition-colors hover:border-ring/50", className)}>
      {/* Cards pin the icon to the corner; inline facts keep it next to the label it names. */}
      <dt id={`${id}-label`} className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", card && "justify-between gap-3 text-sm font-medium text-foreground")}>
        {!card && Icon && <Icon aria-hidden="true" className="size-3.5 shrink-0" />}{label}{card && Icon && <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
      </dt>
      <dd id={`${id}-value`} className={card ? "text-lg font-semibold tracking-tight tabular-nums sm:text-xl" : "text-sm font-medium"}>
        {href ? (
          <a href={href} aria-labelledby={`${id}-label ${id}-value ${detail ? `${id}-detail ` : ""}${id}-to`}
            className="flex items-center justify-between gap-2 rounded-sm outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-3 focus-visible:after:ring-ring/50">
            {valueLine}
            <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-hover/fact:translate-x-0.5" />
            <span id={`${id}-to`} className="sr-only">，查看{destination}</span>
          </a>
        ) : valueLine}
      </dd>
      {detail && <dd id={`${id}-detail`} title={detail} className={cn("text-xs text-muted-foreground break-keep", tone && "ml-4")}>{detail}</dd>}
      {children && <dd>{children}</dd>}
    </div>
  );
}

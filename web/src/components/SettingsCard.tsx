import { Children, type ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The one card style. Children are rows; falsy children are skipped and the
 * rest are divided by hairlines. Set `flush` for content that owns its padding.
 */
export function SettingsCard({ title, description, action, children, className, label, flush = false, ...props }: {
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Accessible region name when the card has no visible title. */
  label?: string;
  flush?: boolean;
} & Omit<React.ComponentProps<"div">, "title">) {
  const rows = Children.toArray(children);
  return (
    <Card className={cn("@container gap-0 py-0", className)} role={label || title || props["aria-label"] ? "region" : undefined} aria-label={label ?? title} {...props}>
      {title && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 @sm:px-6">
          <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
            <h2 className="text-base font-semibold tracking-tight">{title}</h2>
            {description && <div className="max-w-prose text-sm text-pretty text-muted-foreground">{description}</div>}
          </div>
          {action}
        </div>
      )}
      {/* Rows that render nothing in place (e.g. a closed dialog) collapse with their divider. */}
      {rows.map((row, index) => (
        <div key={index} data-slot="settings-row" className={cn("border-t first:border-t-0 empty:hidden", !flush && "px-4 py-4 @sm:px-6")}>{row}</div>
      ))}
    </Card>
  );
}

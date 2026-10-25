import { Children, Fragment, type ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/**
 * The one card style. Children are rows; falsy children are skipped and the
 * rest are divided by separators. Set `flush` for content that owns its padding.
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
        <div className="flex flex-col gap-1 border-b px-4 py-4 @md:flex-row @md:flex-wrap @md:items-baseline @md:gap-x-4 @sm:px-6">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="min-w-0 flex-1 text-sm text-pretty text-muted-foreground">{description}</p>}
          {action}
        </div>
      )}
      {rows.map((row, index) => (
        <Fragment key={index}>
          {index > 0 && <Separator />}
          {flush ? row : <div className="px-4 py-4 @sm:px-6">{row}</div>}
        </Fragment>
      ))}
    </Card>
  );
}

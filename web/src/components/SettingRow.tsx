import { useId, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { FadeText } from "@/components/Motion";
import { cn } from "@/lib/utils";

/**
 * Title and description on the left; status text and control on the right.
 * In narrow cards the title and description span the row, with controls
 * right aligned below. `inactive` keeps a saved-but-not-effective
 * switch visibly on with a weaker fill while leaving it operable.
 */
export function SettingRow({ title, description, status, pending = false, control, inactive = false }: {
  title: string;
  description?: ReactNode;
  status?: string;
  pending?: boolean;
  control: ReactNode;
  inactive?: boolean;
}) {
  const titleId = useId();
  return (
    <div role="group" aria-labelledby={titleId} data-inactive={inactive || undefined}
      className="grid grid-cols-1 items-center gap-x-6 gap-y-2 @md:grid-cols-[minmax(0,1fr)_auto]">
      <h3 id={titleId} className="col-start-1 row-start-1 text-sm font-medium">{title}</h3>
      <div className={cn("col-start-1 row-start-3 flex min-w-0 flex-wrap items-center justify-end gap-3 @md:col-start-2 @md:row-start-1 @md:row-span-2",
        inactive && "[&_[data-slot=switch][data-state=checked]]:bg-primary/40")}>
        {status !== undefined && (
          <span role="status" className="flex max-w-48 items-center gap-1.5 text-right text-sm text-muted-foreground">
            {pending && <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin" />}
            <FadeText id={status} />
          </span>
        )}
        {control}
      </div>
      {description && <p className="col-start-1 row-start-2 text-sm text-pretty text-muted-foreground">{description}</p>}
    </div>
  );
}

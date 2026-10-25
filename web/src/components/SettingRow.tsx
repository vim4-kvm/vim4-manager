import { useId, type ReactNode } from "react";
import { Spinner } from "@/components/Spinner";
import { FadeText } from "@/components/Motion";
import { cn } from "@/lib/utils";

/**
 * Title and description on the left; status text and control on the right.
 * In narrow cards the title and description span the row, with controls
 * right aligned below. `inactive` keeps a saved-but-not-effective
 * switch visibly on with a weaker fill while leaving it operable.
 */
export function SettingRow({ title, badges, description, status, pending = false, control, inactive = false }: {
  title: string;
  /** Small labels shown inline after the title (kept outside the heading name). */
  badges?: ReactNode;
  description?: ReactNode;
  status?: string;
  pending?: boolean;
  control: ReactNode;
  inactive?: boolean;
}) {
  const titleId = useId();
  return (
    <div role="group" aria-labelledby={titleId} data-inactive={inactive || undefined}
      className="grid grid-cols-1 items-center gap-x-6 gap-y-1 @md:grid-cols-[minmax(0,1fr)_auto]">
      <div className="col-start-1 row-start-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h3 id={titleId} className="text-sm font-medium">{title}</h3>
        {badges}
      </div>
      <div className={cn("col-start-1 row-start-3 flex min-w-0 flex-wrap items-center justify-end gap-3 @max-md:mt-2 @md:col-start-2 @md:row-start-1", description && "@md:row-span-2",
        inactive && "[&_[data-slot=switch][data-state=checked]]:bg-primary/40")}>
        {status !== undefined && (
          <span role="status" className="flex max-w-64 items-center gap-1.5 text-right text-sm text-muted-foreground">
            {pending && <Spinner />}
            <FadeText id={status} />
          </span>
        )}
        {control}
      </div>
      {description && <p className="col-start-1 row-start-2 text-sm text-pretty text-muted-foreground">{description}</p>}
    </div>
  );
}

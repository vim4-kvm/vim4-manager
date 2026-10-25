import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Fixed metadata tracks shared by file browsers and the image library. */
export function FileColumns({ children, size, date, actions = false }: {
  children: ReactNode; size?: ReactNode; date?: ReactNode; actions?: boolean;
}) {
  return <span className={cn("grid w-full min-w-0 items-center gap-x-3 text-left",
    size !== undefined ? "grid-cols-[minmax(0,1fr)_7rem]" : "grid-cols-1",
    date !== undefined && "@lg:grid-cols-[minmax(0,1fr)_7rem_9rem]",
    actions && "max-md:pr-10 pointer-coarse:pr-10") }>
    <span className="flex min-w-0 items-center gap-2 break-all whitespace-normal">{children}</span>
    {size !== undefined && <span className="text-right text-xs text-muted-foreground tabular-nums whitespace-nowrap">{size}</span>}
    {date !== undefined && <span className="hidden text-right text-xs text-muted-foreground tabular-nums whitespace-nowrap @lg:block">{date}</span>}
  </span>;
}

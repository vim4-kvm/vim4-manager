import type { ReactNode } from "react";
import { pageMeta, type PageId } from "@/shell/pages";

/** The page owns its heading so primary actions stay beside the title. */
export function PageHeading({ page, action }: { page: PageId; action?: ReactNode }) {
  const meta = pageMeta(page);
  return <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
    <div className="min-w-0 flex-1 basis-64 space-y-1.5">
      <h1 id="page-title" className="text-2xl font-medium  md:text-3xl">{meta.title}</h1>
      {meta.description && <p className="max-w-3xl text-sm text-pretty text-muted-foreground">{meta.description}</p>}
    </div>
    {action && <div className="flex max-w-full flex-wrap items-center gap-2">{action}</div>}
  </header>;
}

import { Skeleton } from "@/components/ui/skeleton";

/** Rows stand in for a settings card while preserving its reading message. */
export function PanelSkeleton({ label, rows = 3 }: { label?: string; rows?: number }) {
  return <div aria-busy="true" className="flex flex-col gap-5">
    {label && <span className="sr-only">{label}</span>}
    {Array.from({ length: rows }, (_, i) => <div key={i} className="flex items-center justify-between gap-6">
      <div className="flex w-2/3 flex-col gap-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-3 w-full" /></div>
      <Skeleton className="h-8 w-16" />
    </div>)}
  </div>;
}

import type { ReactNode } from "react";
import { Info, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export function Notice({ children, warning = false, className }: { children: ReactNode; warning?: boolean; className?: string }) {
  const Icon = warning ? TriangleAlert : Info;
  return <div className={cn("flex items-start gap-2.5 rounded-lg border border-transparent bg-muted/60 px-4 py-3 text-sm text-muted-foreground", warning && "border-warning/25 bg-warning/5 text-warning-foreground", className)}>
    <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
    <div className="min-w-0 text-pretty">{children}</div>
  </div>;
}
